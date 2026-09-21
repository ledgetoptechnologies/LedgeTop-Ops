# API-first migration — current implementation objective and work register

Updated September 19, 2026. The owner approved implementation and resumption after confirming the decisions recorded in this work register. This is the current scope for engineering work; it supersedes conflicting target-architecture recommendations in older handoffs, not the safety rules of the still-deployed system.

### September 19, 2026 — current joined-window gate recheck

- The Ops staging Cloudflare Access policy **Ledge Top Staging Staff Access**
  explicitly includes `beaukoltz@ledgetopdroneservices.com`. A live in-app
  session loaded the authenticated administrator view for Beau Koltz. This
  confirms the authenticated delivery path, not Project-v2
  authority or acceptance.
- The exact PA staging candidate remains
  `ff42c3432f39e50e92058b21d7e4942c26f5b355`. Fresh nonmutating capability
  probes with key **#8** returned HTTP `200`, `apiVersion: 2`,
  `implementedEndpointCount: 23`, and `grantedCapabilityCount: 1`. PA is
  therefore still Directory-only, not in the required Project-only window.
  No Project authority, Ops route, selected connection, or mutation
  was activated.
- The local Operations check and build pass. Focused diagnosis of
  `authenticated-delivery-change-notifications` (`batches forty together`)
  passes in about 100 seconds because it performs roughly 90 sequential
  Miniflare/D1 operations on Windows; it is not a deadlock or functional
  regression. The pure-function batch suite passed 11 tests and the access-code
  suite passed 2 tests. The broad suite has no trustworthy complete total.
  GitHub PR98 checks were rejected in about two seconds by the account
  spending/build limit, not by code failures. No joined Project acceptance is
  claimed.

### September 19, 2026 — Operations staging entry recovery

- The first Access-authenticated Operations staging request reached Worker
  version `b0816c47-fed1-4851-8456-c9eaf1370892` and exposed an unrelated
  fail-open configuration bug before the ordinary authenticated router:
  `isIncomingPublicRequest` attempted to parse an absent
  `INCOMING_BASE_URL`, producing Cloudflare Error 1101. Commit `56cfe9a`
  makes the public Incoming host gate fail closed when neither Incoming host
  setting is configured, preserves explicit-host precedence, and rejects
  malformed fallback URLs. The focused gate suite passes 9/9, Operations
  typechecking passes, and an independent focused review found no security or
  regression concern.
- The reviewed fix was first uploaded as isolated staging version
  `af66e2ec-e4f3-4e40-87c0-608b7aea3043`. The first authenticated browser
  retry then exposed that the isolated acceptance config omitted the static
  `ASSETS` binding, so it could not serve the Operations SPA needed to call
  `/api/session`. The production-equivalent SPA asset contract was added only
  to the ignored staging config, the app rebuilt successfully, and version
  `9aa05566-bf5d-4eba-b2fd-20c8a11d8eb0` was uploaded. Inspection confirmed
  the exact two existing secrets, the same staging D1/R2 bindings, and the new
  `ASSETS` binding; a 100% dry run preceded its 100% deployment. The staging
  UI now loads and fails closed for the still-active unmatched Gmail identity.
  No production route, data, secret, or Incoming retention setting changed.
- The reusable staging staff policy admitted only the Gmail test identity,
  while the existing synthetic Operations owner is keyed to a different exact
  email. The policy now retains the existing tester group and adds only that
  exact owner email as a second OR rule. The database correctly remains
  unbound until a fresh Access session uses the matching identity; no email
  aliasing, subject bypass, duplicate staff record, or direct D1 mutation was
  introduced. Canonical migrations are current and the pre-authority readback
  remains clean: zero admissions, profiles, Directory grants, Project grants,
  Directory fences, and pending/leased Directory or Project commands.
- A staging contract audit found that `NATIVE_STAFF_ONBOARDING_AUD` was an
  unused required value: no onboarding HTTP route exists, while every live
  native staff path verifies only the ordinary Operations staff audience and
  an existing native admission. The unused audience plumbing and staging
  prerequisite were removed without changing the exact single-audience JWT,
  human-app token, issuer, subject/email, or admission checks. Focused native
  auth, monitor, acceptance-route, scaffold, and preflight suites pass; an
  independent security review found no regression. The preflight suite now
  also explicitly rejects an Operations staging config missing its SPA assets.

### September 18, 2026 — Directory bootstrap release and staging prerequisite checkpoint

- Operations PR97 is merged to `main` at
  `5cfcba3e7b621c8cb23217f583aaa2fd5ab3f711`. Pull-request workflow
  `35387044730` and authoritative post-merge workflow `35388479643` both
  passed all ten Operations, Client, Ops Sync, browser, source-invariant,
  Incoming, and thumbnail jobs. This releases the default-off,
  staging-environment-only Directory bootstrap endpoint at
  `POST /api/admin/project-alpha/directory/v2/bootstrap` with exact staging
  source/origin pins, native administrator admission and identity rechecks,
  durable command/idempotency recovery, strict PA receipt/readback validation,
  and mapping creation only after the remote identity and binding are proven.
  Production remains hidden before authentication because the checked-in gate
  is false and the route also requires `ENVIRONMENT="staging"`.
- PA staging Directory acceptance key **#9** was created with exactly the 23
  reviewed capabilities and Directory read/create/write/relationship/
  lifecycle/binding/inventory scopes. Its one-time secret is retained only in
  a Windows DPAPI-protected file outside the repository; decryption was checked
  without printing the value and no plaintext copy was persisted. The binding
  dry run and explicit apply completed; an authenticated capabilities probe now
  returns HTTP 200 with the expected source, application, and history identity.
  Existing key #5 remains active until the replacement completes acceptance;
  it must not be revoked merely because its one-time value is unavailable.
- PA staging is healthy over LAN and its control API, and the restored tunnel
  ingress returns HTTP 200 at the public staging hostname. After the initial
  rehearsal failed closed before mutation with
  `directory_capabilities_contract_mismatch`, the host was moved into the exact
  Directory-only feature window. Key #9 then advertised the exact 23 granted
  capabilities and 23 implemented endpoints (capabilities plus 22 Directory
  and binding endpoints), with zero Project endpoints and matching source,
  application, and history identities. The live mutation rehearsal passed all
  71 paced requests with zero `429` responses or retries. It proved create,
  exact replay, changed-body conflict, read, update, stale binding and refresh,
  relationship assign/move/remove, archive/restore, tombstone/no-auto-rebind,
  explicit rebind, inventory, revision, and authorization-generation contracts.
  Disposable records and immutable audit history were retained; no hard delete
  was attempted. The governed Operations bootstrap remains pending because the
  isolated staging D1 currently has no bound staff subject, active native
  admission, or global `directory.profile.edit` grant. Establish those only
  through the reviewed native-authority packet before enabling the bootstrap
  route or selected PA connection. Local acceptance tooling remains green at
  45/45 Directory and 6/6 joined Project tests.
- Project Alpha PR184 remains open at
  `ff42c3432f39e50e92058b21d7e4942c26f5b355`; CI, CodeQL, and Gitleaks are
  green and GitHub reports it cleanly mergeable. It must remain unmerged until
  the Directory-only bootstrap window, the subsequent Project-only joined
  command/read/settlement window, and public-link preservation checks all pass.

### September 18, 2026 — PA lifecycle and joined-window checkpoint

- Operations PR93 is merged to `main` at
  `ccc32ed31a1781459ecdf8e3719d980eb05c5777`. Its authoritative post-merge
  workflow `35366079255` completed successfully and all ten Operations,
  Client, Ops Sync, browser, source-invariant, Incoming, and thumbnail jobs
  passed. The current Project Alpha PR184
  candidate is `ff42c3432f39e50e92058b21d7e4942c26f5b355`; its CI, CodeQL, and
  Gitleaks checks are green. The candidate now serializes API-key rate-limit
  admission per key and fails closed on accounting errors; its disposable
  MySQL 8.4 concurrency gate is mandatory in CI.
  The checked-in disposable Project lifecycle artifact now proves archive,
  exact replay/conflict, restore, and public-link revocation/preservation
  behavior on that exact `ff42c343` candidate. The guarded run used the
  fixture's verified current revision `7`, advanced it to `8` and `9`, and
  observed public-link statuses `200 -> 404 -> 404` without storing the URL.
- The staging Project acceptance key **#6** is application-bound and has been
  temporarily extended from the reviewed Project acceptance surface with only
  Project archive and restore for the exact-candidate lifecycle rerun. Its
  one-time secret is no longer available to the acceptance runner. Replacement
  key **#7** was bound to the existing staging application, but its one-time
  secret is also no longer available. Replacement least-privilege key **#8**
  has exactly the eight reviewed lifecycle-acceptance scopes and no legacy
  broad access; its one-time secret is retained outside the repository. Key
  #8 is bound to the existing staging application, and its live capabilities
  response advertised exactly those eight routes. Refresh, Directory, and all
  other scopes remain absent.
- Before the joined window, the PA staging server flags and key must have
  archive and restore removed again, with Project binding enabled. The base
  Project flags and binding-status/inventory prerequisites must remain limited
  to staging.
- Staging-only Docker workflow `35361793571` published the exact candidate and
  passed both Trivy scans. The documented control rebuild completed
  successfully; the healthy PA staging container reports
  `APP_VERSION=ff42c34`. Operations staging Access/deployment and the joined
  acceptance harness remain pending. Operations PR95 is merged at
  `a78bc056edcc3a7b559e724bb23b63cf4948dd66`; exact post-merge workflow
  `35376769639` passed all ten jobs. The next proof must exercise the joined
  route with the reviewed least-privilege key and preserve an existing
  Operations-side public link.

### September 17, 2026 — default-off joined Project-v2 acceptance mount

- Operations now has one manually invoked, staging-environment-only composition endpoint at
  `POST /api/admin/project-alpha/projects/v2/commands`. It is hidden unless
  `ENVIRONMENT="staging"` and
  `PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED="true"`; the selected entry in
  deployment-owned `PROJECT_ALPHA_API_V2_CONNECTIONS` must also be explicitly
  enabled. The checked-in production and staging defaults remain `false`.
- One bounded, duplicate-member-free request must explicitly name the source,
  expected application UUID, canonical create/update/bind command, local
  expectation, reviewed project scopes, and an `Idempotency-Key` identical to
  the command UUID. Refresh remains unsupported. The route composes the
  producer, pending dispatcher, authenticated read settlement, and canonical
  activation in that order. It does not mount the older direct settlement
  adapter.
- The route has no UI, GET surface, public/client route, queue, service
  binding, or scheduler. Existing staff authentication, administrator and
  same-origin CSRF checks are joined with deny-aware global
  `integrations.manage`, a second native-staff assertion verification, exact
  legacy/native identity equality, exact authenticated admission/profile
  version and email rechecks at write time, and the existing live
  `project.shared.sync` grant proof. Actor identity and assertion expiry are
  never accepted from JSON.
- Every invocation writes a bounded administrative request audit before any PA
  call and a bounded completion audit after the terminal stage. The existing
  immutable command, acknowledgement, read-settlement, and activation ledgers
  remain the idempotency and recovery authority. Responses omit request bodies,
  credentials, connection topology, preflight capability lists, and raw
  transport diagnostics.
- Enabling the flag is not production authority. A staging window still
  requires applied/verified Operations migrations `0119` through `0122`, an
  enabled disposable PA connection, the existing distinct native onboarding
  audience, an admitted administrator with an explicit native project grant,
  disposable create/update/bind fixtures, rollback evidence, and public-link
  preservation checks. Restore the flag and selected connection to disabled
  immediately after the bounded run. Production activation remains prohibited.

### September 17, 2026 — latest staging evidence checkpoint

- Operations PR82 merged to `main` at `ecf9d24`. It adds the private,
  default-off Project-v2 pending dispatcher and its fail-closed lease,
  terminal-replay, destination-identity, and preservation boundaries. The
  At that merge checkpoint the dispatcher was transport-capable through its
  injected sender but deliberately unmounted, with no deployed production
  caller or public route. The newer default-off administrator composition
  described above supersedes only that source-mount statement.
  It therefore makes no production call and does not mutate a public link or
  activate Project-v2 workflow authority. The authoritative post-merge
  workflow `35291426513` completed successfully at exact head
  `ecf9d24ef839793dd32d98435b48686a865b2e14`; all 10 jobs passed.
- Operations PR79 merged to `main` at `3f5ec3a`. It adds the dormant Project v2
  command producer; at that checkpoint the producer was unmounted and made no
  network call.
  Operations PR80 merged to `main` at `2befb68`, adding the Incoming upload
  form's conditional access-code behavior and centered responsive controls.
  The exact combined `main` workflow `35281356118` passed all 10 jobs.
- Project Alpha PR184's current head is `e260abeb`. It includes the generic
  existing-application key-binding CLI, added after staging exposed a separate
  application-identity conflict. SQLite passed **15/64** and disposable MySQL
  passed **10/81**; PR smoke, CodeQL, and Gitleaks are green. Docker publish
  workflow `35283843624` and Trivy are green. Staging was rebuilt healthy from
  the exact `e260abe` image. Unauthenticated capabilities returned JSON 401
  with `no-store` and no cookie, and the web-log window contained no errors or
  warnings.
- The remaining gate is to create or rebind a temporary Project-only key to
  shared application UUID `150cb108-af37-4973-ab6e-f6d991a6e8c8`, then run live
  Project acceptance. Binding/refresh/lifecycle/public-link parity remain after
  that acceptance. PA `main` is not merged. This checkpoint claims no
  production activation and records no secret or client data.

### September 17, 2026 staging release-candidate checkpoint

- Operations PR71 merged to `main` as `c58aa171`. Its ten PR-head checks
  passed, and all ten jobs in the exact post-merge `main` workflow also passed.
  The merge adds the default-off, per-instance Project Alpha outage monitor
  and stale-data presentation; it does not enable monitoring or change a
  production credential, route, public link, or Project Alpha grant.
- Project Alpha PR186 merged the reviewed API-first candidate to `dev` as
  `fae48c10`. CI, Docker/Trivy, CodeQL, and Gitleaks all passed on that exact
  merge. Staging was rebuilt from the resulting `:dev` images and reports
  `vfae48c1`; the database is healthy, the migration container exited zero,
  and the web container is healthy.
- The public staging tunnel is now routed correctly. Public login returns HTTP
  200. Without credentials, `/api/v2/capabilities` returns 401 and the
  default-off `/api/v2/ops/snapshot` returns 404. This supersedes the September
  16 ingress-blocker statement below.
- An authenticated, read-only staging smoke covered the dashboard, client and
  organization lists, Projects, workforce time and review, API keys, directory
  management, and the retained legacy-integration settings page. All nine
  pages returned HTTP 200 with no fatal marker; the corresponding web-log
  window contained no error, fatal, exception, or warning line.
- The live acceptance credentials are now split by responsibility. Project key
  `#4` is bound to application
  `2c0b12a8-0abe-418d-b33f-6f46805cf84c` with exactly ten reviewed scopes and
  deliberately excludes the unused complete and cancel routes. Directory key
  `#5` is bound to application
  `150cb108-af37-4973-ab6e-f6d991a6e8c8` with exactly 23 reviewed scopes. No
  secret value is retained in this record. These bindings supersede the older
  single-key staging checkpoint below; every replacement route remains subject
  to its default-off deployment flag. No production PA instance, authority
  policy, legacy writer, or public link was changed.
- The container-local migration gate is complete. Directory dry-run/apply
  reported `scanned 1, inserted 1, current 0`; Project dry-run/apply reported
  `scanned 0, inserted 0, current 0`, with zero presentation revocations.
  Neither bounded apply returned a resume cursor, and the final dry runs found
  no remaining inserts. The retained non-secret attestations are directory
  `7d315e254ce5167c5cc6b9f1a0c14802bf95edbd0aa1807d3309b8bcc4b0f1b2`
  and Projects
  `8f6e7bbde18f639a446d93414c5dfb5a58a8d773dce0ee503b8791df70ca8a25`;
  the Project release checker reports the latter current.
- This supplied container-local evidence proves bounded migration and current
  attestation state only. It is not live authenticated acceptance and does not
  prove writes, reconciliation, rollback, public-link parity, or an authority
  cutover on staging or either production instance.
- Operations PR75 merged to `main` as
  `44b12cf924e49d21f167db5f83eec62f1d05d450`. All ten jobs in its exact
  post-merge workflow `35239963223` passed. Its Project API-v2 acceptance
  harness passes **19/19** focused contract cases after the merge. This is
  source-history and CI evidence, not proof of deployment, route enablement,
  migration, or live synchronization.
- The separately reviewed Directory API-v2 acceptance harness passes **41/41**
  focused cases, including exact route/scope/schema checks, safe reruns,
  revision and authorization-generation transitions, pinned inventory
  pagination, replay/conflict behavior, signed-64 bounds, and pre-mutation
  profile validation. The joined source invariants pass **15/15** and the
  Project harness still passes **19/19** on the rebased candidate. No
  credentialed Directory mutation is claimed by these local results.
- Exact Operations `main` transport regression coverage now passes **55
  tests / 3 files**, and the cross-app TypeScript check passes. A reviewed,
  non-production runner at
  `scripts/pa-api-v2-staging-acceptance.mjs` requires an explicit mutation
  opt-in plus a `pa-acceptance-*` fixture prefix, reads
  secrets only from the environment, and emits sanitized status/identity/
  revision evidence. Its live non-mutating baseline passed: capabilities
  returned JSON 401, disabled Project inventory returned JSON 404, neither
  redirected or set a cookie, both were `no-store`, and the corresponding PA
  web-log window contained no error or fatal entry.
- Operations Project-v2 adapters remain unreachable except through the one
  default-off administrator composition; an import-graph regression enforces
  that boundary and continues to prohibit the older settlement adapter. The
  remaining live gate is still disposable joined acceptance, not evidence of
  an active production Operations-to-PA synchronization path.
- A dormant, no-network Operations Project-v2 command producer now reserves a
  deliberately selected source, current staff authority proof, canonical
  request fingerprint, pending outbox row, reservation, event, and settlement
  intent in one D1 batch. Exact retries revalidate the complete destination
  identity and current actor proof; cross-source command-ID reuse conflicts,
  revoked actors cannot replay, create commands must match the selected
  Directory records, and bind commands must match the native projection hash.
  Independent review found and closed those four fail-closed boundaries; the
  focused producer/import-graph suite passes **10/10**. That historical result
  predates the default-off administrator composition above and did not itself
  enable a route or change production.
- The isolated Directory-only live window has now passed. A dedicated key
  advertised the exact 23 reviewed scopes while every Project flag remained
  dark. The mutable run completed capabilities, paginated inventory, two
  organization creates, one client create, exact replays, changed-body
  conflicts, readbacks, profile updates, stale-binding detection and refresh,
  organization assign/move/remove, archive, restore without implicit authority,
  explicit rebind, and final inventory verification. The sanitized schema-v3
  report contains 31 named stages, final authorization generation `23`, five
  inventory pages, and only request IDs and SHA-256 evidence; no credential,
  profile, external ID, or public ID is retained in this record.
- The first diagnostic run exposed two acceptance-tooling facts rather than a
  failed PA mutation. Empty optional address fields are canonically returned
  as `null`, and the dense replay/conflict rehearsal can exceed PA's normal
  60-requests-per-minute key limit. The successful run preserved that limit
  and used bounded pacing. Operations PR78 makes the canonical nullable read
  contract and bounded `Retry-After`-aware pacing permanent in the harness.
- Browser verification proved the API-created organization was visible and
  editable through the ordinary PA administration UI. It also found a release
  blocker on the client list: migration 0099 gives both joined tables an
  `archived` column, while the list used unqualified `archived=0`, so MySQL
  returned a shell-only HTTP 200 page. PA PR184 now contains generic fix
  `dd8c0ea5` (`c.archived=0`) plus regression coverage and MySQL rebind replay
  coverage in `d7177def`. The exact PR184 head passed its normal CI, its
  workflow-dispatched web/cron/database staging images passed both Trivy
  scans, and staging was rebuilt as `vdd8c0ea`. The client list then rendered
  normally and displayed all three disposable API-created clients, including
  the completed acceptance client, with ordinary view/edit controls present.
  The blank-list release blocker is closed; no production image or instance
  was changed.

#### September 18 Operations staging-authority packet merge

- Operations PR87 merged to `main` as
  `33f77c0600ca71673ec0bb7d3f83700c5090da89`. Its exact PR head passed all
  ten required checks, including both desktop/mobile browser suites and the
  native synchronization suite. The exact post-merge `main` workflow
  `35312220232` also passed all ten jobs.
- The merge adds the reversible, operator-invoked staging native-authority
  packet and its contract tests. It does not enable a production authority,
  mutate either production PA instance, change a public client link, or
  retire any legacy writer.

#### September 18 Project API-v2 live staging acceptance

- Project Alpha PR184 head
  `0ed79bed12bd02fb4596868e0e28fea94ed8ab26` is mergeable and all five
  repository checks passed. The branch-specific Docker workflow
  `35300503305` built and scanned the web, cron and database images
  successfully. Staging was rebuilt from that candidate, remained healthy,
  and reported `v0ed79be` before any acceptance mutation.
- Dedicated API key `#6` is bound to staging-only generic application
  `150cb108-af37-4973-ab6e-f6d991a6e8c8` (database application row `3`). Its
  dry run passed before apply, the apply succeeded, and the staging web
  container remained healthy. It initially granted exactly six capabilities:
  API capability discovery, Project read/create/write, Project-binding status
  and Project inventory. The authenticated capabilities document exposed
  exactly those six routes and scopes, with no surplus grant.
- The mutating Project acceptance runner completed with `status: passed`.
  It proved private create (`201`), exact replay, changed-body conflict
  (`409`), read-after-create, conditional profile update (`200`), update replay
  and changed-body conflict, binding status and complete inventory. The
  disposable Project remained unpublished with its public link disabled
  throughout that canonical runner.
- An ordinary signed-in PA browser edit then renamed that same API-created
  Project and advanced its revision from `2` to `3`. API readback returned the
  browser value at revision `3`; the former binding-status proof returned
  `409`, and a stale API writer fenced at revision `2` also returned `409`
  without changing data. This is direct dual-editor conflict evidence, not an
  automatic conflict-resolution claim.
- A synthetic public link was then deliberately enabled through the normal PA
  browser on the disposable Project. The public HTTPS URL returned `200` and
  the expected Project title. That browser change advanced the Project to
  revision `4` without changing the API projection hash. The URL token is not
  retained in this repository.
- Lifecycle acceptance passed against the exact reviewed disposable fixture at
  revision `4`. Capability discovery advertised exactly the seven selected
  Project routes plus capability discovery (eight endpoints and eight grants),
  with no Directory or unrelated Project route. Archive advanced revision
  `4 -> 5`; exact replay returned the same revision and result; a changed valid
  body under the same command ID returned `409`. Restore then advanced revision
  `5 -> 6`, with the same replay and changed-body conflict behavior. The
  synthetic public link transitioned `200 -> 404 -> 404`: archive revoked its
  presentation and restore deliberately did not republish it. The projection
  hash remained the reviewed value. The constrained runner returned before
  inventory, create, profile-write, or binding-status calls, so the stale
  dual-editor binding evidence was not refreshed or overwritten. The sanitized
  machine-readable report is retained in
  `docs/staging/pa-api-v2-project-lifecycle-evidence-2026-09-18.json`.
- A fresh pre-lifecycle check found the staging web and database containers
  healthy, the migration container exited successfully, and the last-hour web
  log window contained no error, warning, fatal or exception line. The
  synthetic public page still rendered its expected Project title without an
  error state. A fresh authenticated capability read still advertised only the
  six base Project routes because archive and restore remain disabled at the
  host; no lifecycle mutation was attempted.
- No production PA instance, Operations production route, public client link,
  authority policy or legacy writer changed. The API token and synthetic
  public-link token remain outside source control.

#### Remaining release gates

- Exercise the joined Operations settlement/reconciliation path and its
  rollback after the direct PA acceptance remains stable. Direct PA success is
  not proof that the currently unmounted Operations adapter is ready.
- Record least-privilege denial after removing the temporary lifecycle scopes,
  and return the lifecycle flags to false. Keep all unrelated Directory and
  Project flags off during this Project-only window.
- Keep Project Alpha PR184 open against `main` until these live gates pass.
  After a successful merge, stop for the owner to deploy and sign in to both
  production PA instances; production acceptance and legacy retirement remain
  separate later gates.

### September 16, 2026 staging application-binding and release checkpoint

- PA staging API key `#1` is now bound to the generic API v2 application
  identity `e4b3b484-ee7c-475f-ad40-46d7f928cff2`. The host-local operator
  procedure completed its dry run before apply, created the directory and
  project authorization-state generation-zero rows, and produced a valid
  capabilities identity. This supersedes only the older statement that the
  binding CLI had never been exercised; it is not evidence for either
  production PA instance.
- An independent authenticated LAN request to
  `http://192.168.60.92:1628/api/v2/capabilities` returned HTTP 200 with a
  present application identity and one granted capability. This proves the
  staging application binding and capabilities route. It does not prove a
  directory/project write, reconciliation, conflict recovery, public-link
  preservation, or a production authority cutover.
- The public staging hostname is not yet valid acceptance evidence. Its
  existing DNS record targets the locally managed `demo-sites` tunnel, but
  that tunnel's inspected ingress table does not contain
  `pa-staging.ledgetoptechnologies.com`; the request therefore reaches the
  catch-all 404. The Cloudflare dashboard cannot add a route to that locally
  managed tunnel. Add `pa-staging.ledgetoptechnologies.com` ->
  `http://localhost:1628` to the host-local ingress configuration before the
  final catch-all, reload the tunnel, and then verify HTTPS and the dedicated
  Access service-auth policy. Keep the existing DNS record rather than moving
  the hostname to another tunnel without a separate network-reachability
  review.
- Operations PR69 merged to `main` at `8abeaf8`; all ten CI checks passed.
  Staging may explicitly defer Mapbox only with both staging tokens empty and
  `MAPBOX_STAGING_ACCEPTANCE_DEFERRED="true"`. The deferral is recorded as
  deferred rather than verified and does not authorize production acceptance
  for a map-dependent workflow.
- The next default-off Operations staging slice accepts an optional complete
  Cloudflare Access service-token pair inside each
  `PROJECT_ALPHA_API_V2_CONNECTIONS` entry. A partial pair, an unsafe header
  value, or an unknown envelope field fails closed. Public configuration
  resolution redacts the API key and both Access values; only the one-shot
  probe/transport bridge receives them, and the headers are absent when the
  pair is omitted. Focused connection/project transport evidence is **53/53**,
  Operations TypeScript passes, staging preflight is **21/21**, and an
  independent review found no secret-handling defect. The immutable staging
  runtime candidate must be advanced to the executable commit containing this
  slice before the documented pair may be installed or exercised.
- No production PA configuration, key, migration, feature flag, public link,
  legacy writer, or authority was changed by this checkpoint. Joined staging
  acceptance remains gated by the public HTTPS ingress, Access service auth,
  exact capability/read/write exercises, retry/conflict evidence, rollback,
  and preservation checks for existing public links.

### September 15, 2026 PA review-branch readiness checkpoint — combined directory CI

- The combined local PA review branch `codex/api-first-directory-ci` is at
  `e353e0ad` (its base includes `b13cb259`). The reviewed fixes are `0b727a39`
  (directory MySQL CI), `bd6de7f5` (MySQL 8.4 reserved alias), `f88608a7`
  (CRLF test portability), and `e353e0ad` (DNS-label runner fix).
- Evidence is **102 migration files valid**, a fresh MySQL 8.4 baseline plus
  migrations `0001`–`0102`, changed-file PHP lint **135/135**, and a focused
  run of **24 files / 195 tests / 2,292 assertions**. Real-runner coverage is
  **project 9/67, client 2/18, directory 4/37, organization 9/63**, with zero
  leftovers. The audit found no code-security blocker.
- This branch is ready only for PA review-branch publication and repository CI;
  it is not ready for production cutover. The branch remains unpushed and all
  related flags remain false. Per-instance backfill, attestation, scoped-key,
  public-link, rollback, and legacy-retirement evidence, plus owner deployment,
  remain outstanding. No secrets are included.
- The Operations branch remains local at `fce6c9c`, with **6 files / 33 tests**.
  No push, deployment, migration, route mount, flag enablement or cutover is
  claimed by this checkpoint.

### September 15 authoritative checkpoint — Operations PR62 and release boundaries

- Operations PR62 merged to `main` at `a58a406`. The merge is source history,
  not approval to publish a potentially public Operations route or capability.
  A specific owner approval is still required before any Operations publication
  that could expose public data or a public endpoint.
- PA candidate `33eae4b0` remains unpublished and undeployed. Current tracking
  estimates are approximately **85% source alignment**, **20% production
  readiness** and **25% joined end-to-end evidence**; these percentages are
  planning estimates, not release or live-acceptance evidence. PA publication,
  deployment to both instances, sign-in and production readiness remain
  unproven.
- The PA/Ops directory-create capability mismatch is fixed locally in
  `a65d765`, but publication approval is pending. The fix has not been
  published, deployed or used to authorize a runtime cutover.
- Dormant private read-evidence recovery is fixed locally in `43e9ab9` using
  forward-only migration `0121`. Focused recovery evidence is **32/32**;
  migration/read evidence is **15/15**; source invariants are **14/14**; and
  TypeScript passes. Full-suite, CI and publication evidence remain pending.
  Migration `0120` is immutable and must not be rewritten or backfilled.
- These local fixes remain dormant: no runtime mount, canonical mapping or
  public-ID/link mutation occurred, and existing public links are preserved.
  No production migration, deployment, publication or authority cutover is
  claimed by this checkpoint.

#### Remaining risks and next gates

- Obtain the specific owner approval for potentially public Operations
  publication, then review the exact candidate and complete full-suite, CI and
  release checks before publishing anything. PR62’s merge alone does not
  satisfy that gate.
- Keep PA `33eae4b0`, directory-create fix `a65d765` and recovery fix
  `43e9ab9` at the owner-review boundary until publication is authorized.
  After approval, publish and deploy both PA instances, verify sign-in and
  configuration, and record migration, backup/restore, staging and live
  acceptance evidence before considering production readiness.
- Preserve the forward-only `0121` path and immutable `0120`; do not apply a
  remote migration, mount a route, or change canonical mappings/public links
  as a substitute for the governed release sequence.
- Complete joined PA/Ops directory-create and private-read recovery acceptance,
  including stale/uncertain/replay behavior and public-link preservation. Keep
  the legacy integration and all replacement paths dormant until those gates,
  CI and coordinated deployment evidence pass.

### September 15, 2026 PA cutover audit checkpoint — candidate `33eae4b`

- Generic PA directory and Project APIs exist, and directory externally-managed
  mode exists, but the related flags remain default-off. Projects intentionally
  remain dual-editor: the owner requires edits in either PA or Operations, with
  one-to-one synchronization and explicit conflict handling. No Project
  ownership lock is desired.
- Per-instance staging/LTT/LTDS non-secret cutover manifests and their evidence
  are missing. Legacy custom-integration retirement criteria and its kill-switch
  are not complete. Public-link compatibility is present at code level but is
  not deployment-verified. The PA migration README also contains documented
  drift stating that lifecycle and relations are unimplemented; reconcile that
  documentation against the candidate before treating the APIs as ready.

#### Next safe actions

- Keep PA unpublished, undeployed and default-off pending explicit owner
  approval; after approval, deploy and sign in to both instances before any
  authority cutover.
- Reconcile the README and candidate route/flag inventory, then produce a
  per-instance non-secret cutover manifest and LTT/LTDS staging evidence for
  synchronization, conflicts, rollback and preserved public links.
- Define and test legacy-retirement gates and a reversible kill-switch, and
  verify public-link compatibility on both deployed instances. Do not add a
  Project ownership lock or retire the legacy integration until joined evidence
  and owner acceptance are complete.

### September 15 approved design checkpoint — forward-only canonical activation

This is an approved design, not an implementation or release claim. The next
increment is additive Operations migration `0122` plus an unmounted adapter.
It must preserve the legacy `0063` adoption and `0086` native-shared-project
branches and their immutable history; it must not rewrite or reinterpret those
rows.

- Before any PA POST, reserve one intent with its canonical request
  fingerprint and a pending event. The reservation is the retry identity and
  must exist before network dispatch; a missing, changed or duplicate
  fingerprint fails closed. The supported command semantics are create, bind
  and update only. This design has no refresh operation.
- After dispatch, activation requires fresh live PA proof for the exact
  source, instance, application, resource, revision and owner/history fence,
  even when a stored response or settlement appears successful. A cached
  response, old receipt or overdue state cannot authorize activation.
  `overdue_warning` is an explicit pending/age signal for operator recovery,
  never an authority grant.
- Once fresh proof passes, one immutable activation-receipt insert is the
  authority for a single D1 transaction that advances the canonical mapping,
  head/history and outbox together. PA and D1 are not treated as one atomic
  transaction: an uncertain cross-system outcome is recovered by the same
  intent/fingerprint and a fresh proof, never by guessing.
- A crash before PA dispatch leaves the intent pending. A crash after dispatch
  but before acknowledgement leaves an uncertain intent that retries the same
  command and body. Stale revision/epoch, changed owner, revoked authority,
  PA denial or unavailable proof leaves canonical state untouched and pauses or
  rejects the intent. No duplicate receipt, head, history or outbox mutation
  is permitted.
- Mounting the adapter and applying `0122` require owner approval for both PA
  instances, a disposable MySQL/D1 migration and recovery rehearsal, and
  fresh live proof from each instance. The release packet must also prove
  dark-create behavior, preserved legacy/public links, no public-link rewrite,
  and rollback/fix-forward handling before any route, flag or scheduler is
  enabled.

The earlier statement that no `0122` migration or adapter was implemented is
superseded by PR82 (`ecf9d24`) and its merged predecessor work. The private
pending dispatcher and canonical-activation components now exist in source:
the dispatcher is transport-capable through its injected sender but has no
mounted/deployed production caller or public route, while canonical activation
is D1-only until its PA transport path is separately mounted. Migration `0122`
exists in `main`/source; remote application and runtime activation remain
separate gates. No production call, canonical mutation, remote migration,
deployment, publication, or public-link mutation is claimed. The authoritative
post-merge workflow `35291426513` is recorded above as terminal success at the
exact PR82 head.

### September 15 implementation evidence — local Operations commit `e1190f2`

Local Operations commit `e1190f2c762a9b991af244f64cda81edacdcea55` implements
the forward-only `0122` migration and the unmounted canonical-activation
adapter. The supported command set is create, update and bind only; refresh is
not supported. The adapter reserves the canonical fingerprint, intent and
pending event before the PA POST. Activation then rechecks live authority,
the project head, canonical mapping, outbox state and directory mappings before
atomically advancing mapping, head, history and outbox state with one immutable
activation receipt. `overdue_warning` is included in the activated project
projection. Existing Delivery behavior and public-link bytes are untouched.

The focused five-file evidence is **31/31**; the activation-specific suite is
**13/13**; an isolated strict TypeScript pass completed; and independent review
found no blocker. The full package TypeScript check is non-actionable because
of stale parent-junction dependencies, not because of this change. The
worktree is clean and the commit remains local only: no runtime mount, push,
deployment or publication occurred.

Remaining gates are CI and publication approval, a populated D1 migration and
recovery rehearsal, a per-instance PA cutover manifest and deployment, live
public-link proof, and coordinated owner acceptance.

Composition note: verified directory-capability fix `a65d765` was cherry-picked
after `e1190f2` into the local activation branch as `fce6c9c`. The combined
focused regression passed **6 files / 33 tests**. No push or deployment occurred;
the source and dependency tree are clean after restoration.

### September 15 — API-first transport and ownership checkpoint

- Operations PR57 merged to `main` at `e8bbfab`. Its dormant Project Alpha
  read/binding-status transport passed the exact ten PR-head pre-merge checks
  and the exact ten post-merge checks (all green). Operations PR58 then merged
  at `ad58c22`; its dormant lifecycle, relationship, revoke and inventory
  transport passed independent QA and the full suite, plus the exact ten
  pre-merge and ten post-merge checks (all green). These are transport
  additions only; they do not authorize a route, flag, key or migration.
- Project Alpha (PA) remains generic/open source and local/unpushed. Local
  commit `0579187f` supplies the external-management framework, which cannot
  be activated until its replacement routes exist. `d5a7cef` supplies the
  lifecycle, relationship and inventory surface with no hard-delete behavior,
  supported by full-suite and MySQL evidence. `a1db652` supplies the project
  lifecycle/read foundation, including derived overdue state and a
  destructive-delete retention guard, with full-suite and MySQL evidence.
  Project create/update, binding, inventory and generation work remain
  explicitly outstanding; the PA owner deployment/sign-in gate remains in
  force. Independent QA also found that restore can revive preserved
  `portal_publish_enabled`/public-token state; a narrow follow-up fix is in
  progress, so `a1db652` is not release-ready.
- The workforce/time audit confirms the staged ownership split: Operations
  owns time capture and work review, while PA owns financial processing. Stage
  the native operational ledger/review independently; employee attestation is
  not independent approval, and approval is not invoicing or payment. Existing
  legacy integration remains in service until its reviewed replacement is
  ready.
- Thumbnail work is explicitly deferred: the current thumbnail path is
  functional and is not on the active API-first migration path. Existing
  production/public links and legacy integration remain protected. No live or
  staging deployment, cutover, or acceptance is claimed by this checkpoint.

### September 15 follow-up — PA archive/restore publication remediation

- PA local commit `b2ad3f83` (parent `a1db652`) closes the previously recorded
  restore-exposure blocker. Archive transactionally clears public and portal
  publication, stops pending managed deliveries and queues accepted revoke
  intents; restore stays dark. Migration `0101` and its backfill harden
  existing rows. The implementation focused run passed **60 tests / 868
  assertions**, the full suite passed **915 tests / 7,407 assertions / 94
  skipped**, and disposable MySQL passed **4 tests / 28 assertions**.
- Independent QA passed the remediation: lint plus **51 focused tests / 815
  assertions** verified transactional public/portal disable, managed-delivery
  stop/revoke, dark restore, and explicit CSRF/ownership-gated republish.
  This closes the `a1db652` blocker; the PA change remains local and unpushed,
  with no staging or production deployment, public-link change, or cutover
  acceptance claimed.

### September 15 final local checkpoint — PA project synchronization candidate

- PA's local, unpushed project-sync chain begins with `9028ea0`, adding
  create/update, permanent binding, status, inventory and revision-refresh
  surfaces. QA found portal-outbox and attestation gaps. `27a7088` fixes the
  zero-portal-projection/outbox case while preserving the internal schedule,
  fresh source versions and no-op behavior, fail-closed schema/current-receipt
  checks, checksum portability and an explicit CI MySQL gate. `11e0654` then
  closes exact PK, unique, supporting-index and FK attestation. Independent
  final QA passed.
- Exact evidence is: full **919 tests / 7,462 assertions / 94 skipped**;
  focused **15 tests / 118 assertions**; disposable MySQL **9 tests / 67
  assertions**; and the QA workflow **10 tests / 68 assertions** plus MySQL
  **9 tests / 67 assertions**. This coherent candidate has reached the PA
  owner gate, not release: no push, deploy, staging or live acceptance has
  occurred. The owner must authorize PA publication, deploy both instances,
  and sign in before any authority cutover.
- This Operations documentation branch also remains local: pushing internal
  architecture documentation was denied pending explicit user approval.

### September 15 PA release-readiness audit

- PA branch `codex/api-first-portal-binding-status` is at HEAD
  `33eae4b0`, 32 commits ahead of its PA `origin/main` base `51e333fb`.
  It is publishable as a review PR only after owner authorization; it is not
  safe to deploy or cut over now. Fresh evidence is the full suite **919 tests
  / 7,462 assertions / 94 skipped**, focused SecurityHardening **19 tests /
  386 assertions / 3 skipped**, passing `php -l` for the scoped files and
  `git diff --check`. Reviewed fixes include lifecycle body wording and the
  legacy broad-scope label.
- Release blockers remain: there is no remote PR CI; automatic migrations
  `0088`–`0102` include material `0095`/`0100`/`0101` changes and have no down
  migration; external backup-and-restore rehearsal, staging, backfill,
  attestation, false flags, and configuration reconciliation are outstanding.
  Ops migration `0119` is unapplied and its adapters remain dormant. Broader
  M05/M06/M07/M08 requirements are incomplete. The legacy custom integration
  is intentionally retained until joined acceptance is complete.

### September 15 follow-up — dormant Operations project transport and persistence

- Operations PR59 merged to `main` at `5286460`. It adds the unmounted,
  default-off consumer transport for PA project read/create/update, explicit
  one-to-one bind, binding status, bounded inventory, lifecycle and
  binding-revision refresh. Canonical command ordering and trusted 404 response
  fencing were independently reviewed; all ten PR-head and all ten post-merge
  checks passed.
- Operations PR60 merged to `main` at `e89364e`. Additive migration 0119 now
  supplies native-only immutable request fingerprints, append-only
  pending/uncertain/conflict/rejected/acknowledged events, transport-validated
  acknowledgement provenance, and exact create/bind/update success receipts.
  It revalidates live authority and fences command, source, application,
  history epoch, destination origin, public ID, revision, projection hash and
  authorization generation. SQLite null-bypass, mutable-evidence,
  destination-provenance and update-contract gaps found during review were
  fixed before publication.
- Final local evidence for PR60 was TypeScript, production build, **21/21**
  focused transport/D1/populated migration-chain tests and an independent
  no-findings review. All ten PR-head CI jobs and all ten jobs in post-merge
  main run `35015527961` passed.
- Operations PR61 merged to `main` at `e85f0dc7bf3dcf520584a5e328c634a882aceda4`.
  Its PR-head CI run `35022737853` passed all ten jobs. The private adapter
  remains unmounted and dormant: it retains exact canonical request-byte and
  raw-response-byte hashes, privately brands rehydrated evidence, reserves
  before dispatch, rechecks authority and destination after reservation, and
  settles the acknowledged event, validated acknowledgement and receipt
  atomically. Refresh remains unsupported. No mapping, shared-project,
  Delivery, or public-link behavior changed. Post-merge main run
  `35024108141` completed successfully with all ten jobs passed.
- These changes remain dormant. No production router, scheduled task,
  persistence adapter, mapping reader, public-link resolver, legacy integration
  path or thumbnail path imports them. Migration 0119 has not been applied to
  remote D1 by this work. The next slice is the private adapter that atomically
  converts only transport-minted evidence into ledger events/receipts, followed
  by reviewed canonical shared-project settlement. Historical rows remain
  collision/provenance evidence and never imply current authority.
- The older M05 joined HTTP/MySQL evidence predates PR59/PR60 and does not prove
  this new project transport or persistence path end to end. Runtime settlement,
  real PA/MySQL integration and both-instance acceptance remain open gates.
- Before implementing that adapter, extend the transport's private provenance
  to retain the exact canonical request-byte hash and exact bounded response-byte
  hash, and privately brand the rehydrated evidence so structural clones cannot
  settle D1 state. Reserve the request before network dispatch; then write the
  acknowledged event, validated acknowledgement and receipt in one D1 batch.
  Refresh remains outside migration 0119. Lost-response retries must reuse the
  same command ID/body/destination, and an exact existing receipt is the only
  replay success. This adapter remains unmounted until its rollback, concurrency,
  stale-authority and byte-for-byte no-public-link-mutation tests pass.
- Thumbnail optimization remains explicitly deferred at the owner's request;
  the currently functional thumbnail path is outside this migration slice.

September 15 migration-safety checkpoint: Operations PR 54 restored the exact
0054–0118 migration chain and strengthened the staging release gate to require
remote-ledger order, quiescent/compatible writers, closed migration fences, and
populated backup plus time-travel recovery evidence. It is merged on `main` at
`ce43e1c`; the post-merge run passed every Operations, Client, Ops Sync,
source-invariant, TrueNAS pickup, and desktop/mobile browser job after one
timing-sensitive Client test passed on its failed-job rerun. This does **not**
mean the migrations were applied remotely or that a native route was enabled.

The corresponding Project Alpha branch is still local and unpushed. Through
local commit `22ca3f85`, its generic API v2 foundation now has app-bound,
default-off client and organization profile commands, immutable receipts,
revision/generation/identity fences, aligned browser/API lock ordering,
delete/restore binding lifecycle repair, explicit same-external-ID rebind after
restore, and retry-safe legacy-ledger validation. Commits `e80fbe90` and
`d8fd73e9` add a persisted full-directory backfill attestation, per-resource
coverage digests, contiguous-history checks, global 0096 schema health, and a
machine-checked inventory of all client/organization SQL writers. Independent
reviews found no remaining source-visible blocker in these slices. The combined
Project Alpha suite passed 882 tests / 7,028 assertions with 94 intentional
skips; focused disposable-MySQL gates also passed. Create commands,
externally-managed read-only enforcement, Operations write adapters, project
identity, and coordinated staging/owner acceptance remain required before a
cutover. No production Project Alpha instance, public link, route, key, or
database was changed by this checkpoint.

Later September 14 onboarding checkpoint: the existing-client invitation panel
now offers an explicit, default-off staff choice for client-only or
client-plus-organization prefill. The private recipient route resolves the
staff's live 0107 intent, independently verified Client Access principal and
deployment-owned PA mapping, atomically completes 0103/0104/0106 evidence,
then reads the current bounded fields. The joined two-Worker test now includes
a fresh invitation with **no preseeded recipient evidence** and proves first
completion, identical reload, no duplicate receipt, and no bearer-only data;
its two cases pass. The real-D1 completion suite passes 2/2, Client focused
tests 12/12, staff HTTP tests 31/31, staff desktop/mobile browser cases 16/16,
Client form/page desktop/mobile cases 24/24, both TypeScript checks, and the
staging preflight/evidence suite 46/46. The separate Client and Operations
prefill switches remain false. No PA instance, public link, production Worker,
or production database was changed. Live staging Access, two-instance mapping,
real invitation and owner review are still required before activation.
The older checkpoint below records the earlier unwired state.

September 14 onboarding checkpoint: the recipient page now uses Project Alpha's
individual/organization choice, contact/company/billing-address field order,
labels and responsive two-column layout. A signed Client Access assertion can
reach the private Operations D1 prefill reader; the local two-Worker acceptance
test passes with exact pinned fields, and invitation-only requests reveal none.
The reader also permits an explicitly client-only disclosure when that client
has an organization relationship, without revealing organization fields. Its
real-D1 suite now passes 6/6, including denial when another active identity
shares the same client. Migration 0105 binds every new disclosure to the exact
recipient binding; older unbound rows cannot disclose. Client now derives a
short-lived standalone-client identity proof from a verified Access principal
and active directory authority, and passes only that proof over the private
Worker binding. Operations resolves its exact source/public ID through the
deployment-owned API connection before checking the invitation target; the
joined two-Worker D1 test passes. Migration 0106 and an unmounted governed
command now create/reuse the exact binding, disclosure and durable retry/audit
receipt (3/3 focused D1 tests). **This is not an activated existing-client
prefill workflow:** the staff command is not exposed through an authorized
interface, the private proof-to-writer handoff is not wired, and live staging
acceptance is outstanding. Organization membership alone cannot prove a
particular contact. No PA deployment, production migration, client grant, or
public link changed here.

## Current objective

Native navigation now includes the discovery contract, native-only session
reader/HTTP adapter, browser transport and a shared shell around implemented
native pages. Built desktop/mobile route acceptance passed 42 cases (`395f5e`);
the backend HTTP suite passed 10. Detailed scope and fixture limitations are in
`native-workspace-navigation.md`. The legacy default landing route still needs
the coordinated authority cutover; this is not production acceptance.

Latest source-gap review: PA-style onboarding fields/layout are preserved, but
existing-client prefill requires the recipient-verification/disclosure work now
specified in `client-onboarding-native-contract.md`; merely adding React props
would not satisfy that boundary. Existing native deep links now use the shared
shell without a PA-role fallback; the default landing route remains legacy.
Navigation visibility is not an authorization decision.
Migration 0103 adds a dormant exact Access issuer/subject-to-client binding and
an unmounted live-invitation eligibility resolver. It is an identity
prerequisite only; it returns no saved client data and does not enable prefill.
Migration 0104 adds an immutable per-invitation client/optional-organization
revision and issuer-view-authority disclosure pin. Migration 0105 additionally
requires an exact active, unexpired recipient binding for every new disclosure;
the reader rejects legacy unbound rows. Migration 0106 adds the immutable
command receipt. The staging migration inventory includes all four additions,
with current local inventory/evidence checks passing 46/46. None is applied to
production here. The live staff-command, proof-to-writer, notification and
real-page gates remain before existing-client onboarding activation.
The renewed PA form comparison and current Client TypeScript check passed;
focused desktop/mobile form and recipient-page browser tests passed 24/24.
The staging inventory now requires the Operations onboarding rate and handoff
secrets and checks the exact private Client-to-Operations service binding;
the combined preflight/evidence/scaffold suite passed 50/50. Onboarding
activation remains prohibited in the release profile pending an approved
evidence-gated plan, recipient prefill authorization and live acceptance. None
of these checks enabled or deployed the link.
The workforce source boundary is recorded in
`native-workforce-implementation-boundary.md`. Migration 0096 supplies an
inactive Operations-local time/bonus revision and review schema; migration
0097 adds default-deny, unseeded scoped authority tied to the existing shared
project identity. The 0096 and 0097 focused D1 suites each pass four cases.
Migration 0098 provides an unmounted first time-record command and immutable
receipt (13/13 D1 tests including controlled grant-revocation interleaving and
concurrent exact-command replay);
migration 0099 provides unmounted beneficiary submit
and independent review commands/receipts (9/9 D1 tests after deterministic
denial/conflict and revoked-actor recovery cases). Migration 0100 adds
an unmounted issuer-only grant revoke/reactivate executor with versioned
history/receipts (6/6 D1 tests after deterministic CAS/recovery hardening);
Migration 0101 adds the unseeded, separate manager/issuer-ceiling schema (5/5
full-chain D1 tests). Migration 0102 and a conditional D1 command add an
unseeded grant-create path; the combined schema/policy/issuance suites passed
14/14. Its exact native HTTP route and root dispatch passed 8/8, but the
route remains default-off with no issuer bootstrap or deployment. Governed
grant changes, successor recovery, and controlled race acceptance remain open.
The separate
`native-workforce-grant-governance-design.md` now records the unseeded issuer,
ceiling, transactional issuance, recovery and race-test prerequisites; it is a
design boundary, not an activated grant path. Operations TypeScript
passes. No route or grant is activated and neither command calculates pay or
invoices. The 0097 evaluator is read-only preflight, not command authorization.
Native job authority, correction and bonus executors, grant governance,
remaining deterministic conflict handling, broader controlled concurrency tests, generic PA
workforce APIs, compensation separation and end-to-end acceptance remain open.

Latest outage-reconciliation list check: all 11 joined reader/HTTP tests passed
(`999732`) after the final expiry guard. UI mounting and deployed acceptance
remain open; this did not settle real alerts or send mail.
The recovery page is now locally mounted behind a separate default-off flag and
dedicated reconciliation grant. A new opaque session actor binding prevents a
different staff identity from recovering an unresolved command. Root's focused
API/transport/navigation run passed 24 cases (`69b4a0`), TypeScript passed
(`4b7611`), the Operations production build completed (`6a2438`), and six
desktop/mobile browser cases with the real navigation shell passed (`79f008`).
The browser tests exercise actual shell expiry, reauthentication, exact-command
replay and cross-actor isolation with synthetic responses. Live operator and
mail-provider acceptance remain open; see `native-integration-alert-reconciliation.md`.
The separately mounted Worker routing now passes three focused cases (`150717`)
and the post-test TypeScript check (`d444e4`); it does not read PA connection
secrets or invoke legacy sign-in for unsupported descendants.

Current release-inventory gate: the expected staging sequence includes the
complete Operations `0054`-`0118` suffix, including the existing append-only
revision-refresh ledger. Inclusion is not approval to apply it: release
evidence must prove the exact remote ledger order, no open migration-relevant
fences, quiescent writers/schedulers, a populated export plus time-travel
recovery rehearsal, and compatible-writer ordering before any remote action.
The release-profile/preflight/evidence/acceptance run passed 82/82 with the
default-off workforce issuer route guard. The 0096
focused schema and 0097 full-chain authority suites each pass four D1 tests,
with 0098 time-record 13/13, 0099 submit/review 9/9, 0100 issuer-only grant
change 6/6, 0101 issuer schema 5/5, and the combined 0102 issuance suites
14/14 separately verified.
This is a local checkpoint, not a deployed migration.
Native feature flags, notification schedules, private binding and workflow are
now represented, with new native activation prohibited and unprovisioned
endpoints explicitly blank. The scaffold accepts valid Wrangler JSONC comments
without altering quoted URLs. Root subsequently corrected its trailing-comma
normalizer so malformed empty containers and missing values remain errors;
all four focused scaffold tests pass (`15a63e`). The independent outage-alert
reconciliation and workforce issuer activation flags are required disabled by
the current release checks. `RELEASE_CONTRACT_FINALIZED` remains false: inventory consistency is
not a production migration, cross-repository release approval or live acceptance.

Latest onboarding delivery acceptance: the existing joined scheduled-delivery
test now loads the complete schema instead of stopping at 0084 and passes
(`91cb70`). It proves local approval→parent/child delivery→acknowledgement for
both synthetic PA identities, lost-acknowledgement exact retries, 100/32/100
address preservation, default-off behavior and no republishing after completion.
Production receiver/configuration acceptance remains open. Submission-review
notifications are now composed locally behind separate default-off job/mail
flags. Joined D1 acceptance passed three cases (`12f4a6`), focused cycle tests
nine (`7c6c2f`), and scheduled routing four (`66ddae`). These use synthetic mail,
not real delivery. Staging flag/configuration evidence and recipient/transport
acceptance remain open; see `client-onboarding-notification-contract.md`.

Outage-email recovery implementation now follows the
[native reconciliation contract](native-integration-alert-reconciliation.md).
The existing scheduler transition is internal-only: operator settlement needs
current native reconciliation authority, an atomic before-state fence and an
immutable command receipt. A provider-accepted attempt must not be resent;
definitive non-acceptance can return to scheduled backoff, while a still-unknown
attempt stays untouched. The parser passes four tests (`3410a1`) and the
unmounted atomic executor passes twelve full-chain D1 cases (`d051af`), including
authority/lease races, rollback and lost-acknowledgement replay. HTTP integration,
operator UI and production acceptance remain incomplete.

Latest September 13 native integration permission checkpoint: the atomic grant
executor passes 14 full-chain D1 cases (`69156c`); the independent target reader
passes five D1 cases (terminal session `82877`) and eight unit cases. Browser
transport plus mounted Worker routing passes 16 cases (`d2f26f`), and Operations
type checking passes (`ef72a6`). The locally mounted namespace remains gated by
the existing default-off native control flag, with no PA-auth fallback or PA
connection configuration dependency. No production permission or deployment
changed. Operator grant controls are now locally mounted and browser-tested
(six actual-route cases `e5bf9a`, sixteen panel cases `fc0dc1`). Native staff
discovery now has sixteen HTTP/D1 checks (session `36261`), five transport checks
(`6384a1`), twelve selector browser checks (`309d5e`) and three reserved-route
checks (`4f6b81`). Reviewed management-authority bootstrap, primary-shell
navigation, uncertain-email HTTP/UI
integration and live acceptance remain outstanding; these
tests do not complete the broader migration. See
[native permission management](native-integration-grant-management.md).

Onboarding review notices now have activation-fenced storage (seven D1 tests,
`97ea00`), a tested dispatcher/configuration parser (12 tests, `ead694`), bounded
maintenance (two D1 tests, `dbad76`), durable scan cursors (three D1 tests,
`51933e`) and an adapter with a tested 45-second uncertain-send timeout (six
tests, `01d812`). The cycle and scheduled Worker entry are mounted locally;
both job and mail flags remain false. Combined cycle/Worker routing and joined
database/mail-adapter acceptance are pending. See the
[notification contract](client-onboarding-notification-contract.md) for recipient
scope, duplicate prevention, no-backlog activation and required tests. No real
notice has been sent and notification rollout remains disabled.

The client onboarding form continues to use PA's existing layout and field
grouping, not a new wizard. Source comparison reaffirmed the 680px card,
individual/organization switch, separate optional company contact details,
billing address and full-width review action. Production onboarding delivery
and acceptance remain pending; see the
[PA layout baseline](client-onboarding-pa-layout-baseline.md).

September 13 control-command acceptance: the server-only configuration command
boundary plus native capability policy passed 12 pure tests (`1b4a13`), after
root corrected an undefined test fixture variable. Only expected revision and
enabled state are accepted from the caller; disable remains possible with
malformed connection configuration. This is not a mounted HTTP route or an
authentication proof. Root's attributed-store review caught an initial null-head
check and a no-op authorization/revision race; both are being corrected before
database acceptance. The two tracked Client 0199 migrations were also inspected:
their SQL objects are independent, so neither should be renamed. An isolated
local Wrangler discovery/apply check is now being prepared to verify that both
full filenames are recorded; manual full-chain tests alone do not prove that.

September 13 inventory readback: running the new guard against the actual
checkout (`8da136`) reported 43 unlisted migrations while 0091 was being added.
This also includes Client `0199_native_viewer_grants.sql`, not just the previously
reported 0210–0213 suffix. Its ordering/dependencies must be reconciled alongside
the full Operations suffix; no migration was renamed or approved by this check.
The native control storage draft now includes immutable grant history and a
revision-keyed operator audit. Root review requires an attributed head to reject
later raw/unattributed updates, and an identical request to recheck current
authorization. Tests and HTTP wiring are still pending.

September 13 native monitoring authorization: the new explicit global native
integration policy passed six focused tests (`69288c`) and TypeScript
(`018d9e`). It requires an admitted, exactly bound native subject, recognizes
only monitor-management/reconciliation capabilities, and makes deny override
allow; PA roles, email and owner flags confer nothing. Root review corrected a
proxy test assumption without adding unsafe property reads. This is advisory
policy, not yet a database or HTTP authorization boundary. Migration 0091 and
an attributed, commit-fenced lifecycle writer are now being implemented with
no seeded grants. Existing staff-control-plane invariants remain unchanged.

September 13 mail acceptance: the uncertain-alert store passed 10 real local
D1 tests (`818cc3`), and SMTP/dispatcher/cycle/scheduler passed all 38 mocked
cases (`19def4`) after correcting a timeout-versus-socket-close race found by
the first run. Root TypeScript passed (`bce19f`), with the final mail correction
also type-checked (`d56363`). Unknown sends now require reconciliation rather
than automatic reclaim/retry. No real mail was sent. Next outage prerequisites
are native-staff-authorized and atomically attributed lifecycle/reconciliation
controls, refreshed staging requirements, and live acceptance; monitoring stays
off. This completes the pending test runs referenced in older checkpoints below.

September 13 release-inventory guard: staging preflight now compares actual
Client/Operations SQL files against the explicit approved post-baseline
inventory, rejecting missing, unlisted or non-regular SQL entries. All 17 Node
tests passed independently (`3714fa`). The guard now requires the complete
Operations 0054–0118 suffix and Client 0210–0213 where applicable; it does not
approve those migrations, finalize the release contract, or authorize a remote
action.
The SMTP/uncertain-alert patches are now locally implemented and type-checked;
their new runtime acceptance remains in progress (store run session 50985).

September 13 combined database acceptance: the frozen full-chain local D1 run
completed successfully (`bf008b`, session 91313): five files and 25 tests passed.
This covers lifecycle control, observation fencing, alert state, the joined
health cycle and joined alert dispatch; it sends no real email. The release
profile now requires the monitor flag explicitly false; its 16 Node tests also
passed independently (`3a5ad4`). These results supersede the active-run statements
below, not the remaining production gates. Current work prevents automatic
retries of an attempted send with an unknown outcome, bounds SMTP transport,
and makes stale staging migration inventories fail closed. An authorized,
audited lifecycle control entry point and live acceptance remain outstanding.
No release, remote migration, or monitor activation has occurred.

September 13 release/transport review: the remaining combined D1 run is active;
no result is claimed yet. Two additional activation prerequisites were found.
First, an attempted mail can outlive lease reclaim; ambiguous attempts must
require reconciliation rather than starting a concurrent retry (pre-attempt
crash reclaim and recorded-failure retries remain supported). Second, the old
staging contract pins Operations only through migration0053 and lacks current
monitor configuration. That contract remains unfinalized; do not finalize it
or deploy on the strength of the narrow monitor tests. The portal release
profile is being strengthened to require monitoring explicitly off until a
separate activation packet is accepted. See the outage contract for detail.

September 13 retirement/schedule checkpoint: after correcting a D1-specific
UPDATE-alias incompatibility, all four atomic retirement database tests passed
(`ee749a`). Actual Worker scheduled-handler plus mocked monitor suites passed
35 cases (`98451b`). The local five-minute cron remains default-off, requires
an explicit lifecycle revision and owner recipient, and cannot initialize its
own authority. Generated bindings and TypeScript passed (`1fca11`, `ee247f`).
The earlier combined D1 run failed during migration setup and was stopped;
remaining full-chain store suites must be rerun. No production change occurred.

September 13 monitoring composition checkpoint: health-cycle, dispatcher, SMTP
and new monitor-cycle mocked suites passed 28 tests (`454538`); root TypeScript
passed (`36c67c`). The composition is bounded, preserves the pinned authorized
monitor revision, isolates per-instance alert failures, and emits only counts.
It is not registered as a cron. Atomic observation/attempt fences are implemented
locally; their combined D1 acceptance with incident retirement is the next gate.

September 13 monitoring lifecycle checkpoint: migration0089 and the explicit
configuration CAS store passed seven real local-D1 tests (`cb074f`). Current
and historical identity sets contain no credentials, missing state is inactive,
stale transitions cannot overwrite a newer revision, and a failed history
append rolls back the configuration head. Caller integration now adds atomic
revision predicates to observation and alert-attempt writes; combined tests,
incident retirement, authorized control entry point, scheduler wiring and live
acceptance are still pending. No production migration/activation occurred.

September 13 alert dispatcher checkpoint: 16 frozen-source tests passed
(`4dd565`), including a real-D1 joined slow-send/acknowledgement race and mocked
SMTP acceptance; root TypeScript passed (`3160dc`). An accepted send is not
repeated merely because a concurrent health observation advances the incident
revision. Pre-send expiry/configuration changes suppress mail, and preparation
failures remain distinct from transport failure. Explicit owner recipient and
durable monitoring lifecycle integration, scheduler wiring and live acceptance
remain required. This local dispatcher is not enabled in production.

September 13 SMTP prerequisite: final DATA acceptance no longer becomes a send
failure because QUIT or cleanup fails. Three local mocked-socket tests passed
(`c30b31`); TypeScript passed (`dd49dd`). No mail was actually sent. The new
incident dispatcher is being implemented separately. Durable monitoring lifecycle
fences must prevent old invocations from restoring disabled/replaced connections
before scheduled activation; see the outage contract. No release occurred.

September 13 joined outage checkpoint: all 39 tests across six policy, parser,
health-cycle and real local D1 files passed (`7b0788`, exit 0). Migration 0088's
durable claim/reclaim, lease fencing, retry/backoff and atomic event rollback
are now verified locally. The joined real readiness-parser/D1 test covers two
independent sources and recovery with synthetic HTTP, without adding commands.
All 88 migrations load with zero foreign-key violations (`829630`). Physical
owner email, deliberate disable/re-enable fencing, scheduled registration and
live acceptance remain pending; no production settings or migrations changed.
The following older checkpoints are historical, not contradictory release claims.

September 13 health-cycle composition checkpoint: a deployment-gated local
orchestrator now probes configured PA directory readiness independently of queued
writes, at most two concurrent probes, with per-source failure isolation and
bounded CAS retry preserving probe start time. Six mocked composition cases
plus policy/parser tests passed 27 cases (`9917f3`); TypeScript passed (`c53e37`).
No cron or production flag was enabled. The pure alert policy now supports
honest reclaim after a pre-attempt crash; durable lease expiry/backoff enforcement
is the pending 0088 alert-store slice. Physical email delivery remains unverified.

September 13 outage persistence checkpoint: migration0087 and the validated
observation CAS store passed the full-chain local D1 regression. All 25 combined
policy/parser/store tests passed (`c608ea`), including atomic history rollback,
concurrent first writers, stale observations/revisions, identity isolation and
malformed-input/state rejection. TypeScript passed (`657b19`); all87 migrations
also loaded in empty Node SQLite (`079347`). No production migration occurred.
Durable alert claims/leases, retry/backoff, scheduler probes with empty queues,
owner mail and production acceptance remain outstanding. See the outage
contract for exact coverage; this is not a completed notification feature.

The outage implementation and acceptance requirements are now recorded in
[the API-v2 outage contract](project-alpha-api-v2-outage-contract.md). Native
Operations must continue beyond ten minutes; that duration triggers an alert,
not shutdown. Continuous non-verified failures retain the same incident across
failure categories. Complete pinned identities, independent observation/action
ordering and incident/claim fencing are required before durable scheduler wiring.

September 13 outage prerequisite audit (root + Sol, source-only): the existing
`integration-health.ts` 26-hour snapshot freshness warning is not the agreed
API-v2 ten-minute outage detector. The new directory scheduler/outbox retains
commands and reconciliation checkpoints, but does not persist per-instance
outage start, delivery claim, sent alert, or recovery state. Its aggregate
dispatch counters are not sufficient to infer source health. The legacy
`alerts.ts` helper can silently skip mail when its separate binding/settings
are absent; do not count that as a successful notification. The next slice is
a pinned-connection outage policy with strict greater-than-ten-minute timing,
ordered observations, explicit transport versus authorization/configuration
failures, and recovery handling. Durable incident/outbox persistence, scheduled
probes when no writes are pending, configured owner delivery, concurrent/retry
acceptance and live two-instance checks are still required. This policy is now
implemented locally as a pure transition policy: all eight tests passed
(`f7c073`) after root corrected a throws-assertion wrapper; TypeScript passed
(`8461e6`). The tests cover strict timing, continuous cross-category failure,
recovery, pinned identities, stale observations, claim fencing and same-ms
delivery actions. Durable persistence, lease recovery, email and scheduler
wiring remain pending; no alert feature is claimed complete or enabled.

September 13 public-link compatibility checkpoint: the real Client Worker and
local D1 passed five migration regressions (`01c41f`). Synthetic public shares
were seeded at schema 0005, snapshotted before applying the remaining Client
migrations through 0213, and checked afterward for unchanged IDs, hashes,
versions, password fields and lifecycle fields. Active links still issued a
session and served a manifest; password links rejected missing/wrong codes and
accepted the original code; expired/revoked links issued no cookie. A fragment
from a different migrated link was rejected. Root corrected an initially weak
post-migration-only snapshot and a non-prefix-aware bucket fixture before this
run. Client TypeScript passed (`104105`) before the final negative assertions.
Luna's independent read-only review confirmed the snapshot boundary. Its requested
protected-link manifest and unknown-public-ID checks were then added; all six
cases passed (`da3f97`), followed by TypeScript (`277e3b`). Production links,
previous signing/pepper overlap, in-flight resumed
downloads and live deployment configuration remain unverified by this suite.
No production deployment or authority cutover occurred. Previously denied PA
writer/view edits and elevated project-sync tests remain on explicit approval
hold; this separate Client-only run does not authorize either.

Latest local checkpoint: the native directory list is mounted at the exact
`/clients/directory` browser route; fresh build and TypeScript passed, followed
by four desktop/mobile built-entry tests (`86039d`) with synthetic API replies.
The record editor and separately gated Worker namespace are now also mounted
locally. Eight fresh built-entry desktop/mobile tests passed (`6bcff9`), and
the signed-JWT/full-chain D1 directory regression passed (`3c98f1`), including
stale-admission rejection without partial writes. Detailed evidence is in
[the native directory contract](native-client-directory-contract.md).
This is not a production authority switch or permission to deploy the isolated
legacy-write retirement before its replacement is ready.

Make Ledge Top Operations the canonical everyday customer, portal, staff and operational-work system for the separate LTDS and LTT businesses. Replace Project Alpha's custom Operations integration completely with generic, versioned, explicitly scoped APIs in one rehearsed and coordinated authority cutover. Keep Project Alpha open source, neutral in its labels/examples, functional standalone, and authoritative for its own users and financial records/actions. Support shared customer management in Ops, project creation and editing in either application with one-to-one permanent links and conflict-aware synchronization, one service-aware customer portal, employee/general time capture with independent review, explicit compensation policies, scoped billing visibility, reliable outage recovery and nonduplicated notifications. Finish Incoming rclone pickup, preserve public delivery and Viewer access contracts, improve the client/admin UX, and include website/reporting and scoped Hermes API work in this phase. Verify migrations, permissions, recovery and real workflows before release. Stop at the PA production-update handoff for the owner to deploy both instances and sign in before the authority cutover.

### Goal control versus implementation status

- The owner has authorized continuing this work. Implementation can proceed in this conversation under these constraints.
- The owner resumed the app goal on September 10; a subsequent `get_goal` confirmed `active`. The owner then replaced its objective with the full API-first architecture via the goal-objective attachment, which the parent read completely. This register implements that updated objective. Keep it current without marking the objective complete merely to change wording.
- Keep this register and the decision record current across handoffs. A status is evidence-backed, not inferred from a table, a merged PR or successful mocks alone.
- Release authority clarified by the owner: for the duration of this goal, tested **Ops** changes may be merged to `main` without another per-PR request. Do not bypass required checks/protections. **PA** changes stay local for preparation/testing; stop at an owner review handoff before merging or releasing PA changes, because both instances are in production. This supersedes any earlier assumption that PA publication could proceed autonomously before that handoff.

## Non-negotiable migration constraints

- **Existing client public links remain usable under their current permissions.** Preserve token verification material, link IDs, stored token hashes, exact scopes/paths, folder/file references, passwords, expiration and revocation state. Do not issue replacement tokens or require clients to obtain new links as a migration shortcut.
- Preserve old `client.*` to `portal.*` routes and the complete path/query needed for existing links; do not put public delivery behind a new staff/client login gate. Never disclose real tokens in test logs, screenshots, fixtures, commits or reports.
- Preserve ordinary and large ZIP downloads, stable completed archive objects/cache identities, Range/If-Range behavior and valid resume. Do not promise resume after the referenced object or entitlement expires. Do not invalidate active links merely because source authority moves.
- Expired/revoked/password-protected links must retain their restrictions. "Keep links working" is not permission to reactivate revoked links, extend expiry or broaden recipient scope.
- Preserve portal identities, existing workspace IDs or explicit compatibility mappings, deny records, individually scoped grants, client files, requests, feedback, audit history and financial snapshots. Never merge people or customers solely by email, name or address.
- Keep PA user admission and ACLs separate from Ops users. Remove the old PA-driven Ops staff reconciliation only when its replacement is ready; it must not undo new Ops-managed staff access.
- Generic PA managed-directory mode is optional and explicitly enabled only with a capable external writer. Loss of that token must not silently enable a second editor. Do not turn historical read keys into broader write keys through legacy aliases or a future-expanding `full` scope.
- Projects may be created/edited in either app. Use permanent source-qualified mappings, idempotency and version checks, not name matching or silent last-write-wins. One project maps to one PA project in a deliberately selected instance. No auto-publication of internal documents through synchronization.
- Operations owns time capture and work review. PA owns financial processing. Employee attestation is not independent approval, approval is not invoicing/payment, and role/ownership does not infer compensation.
- Keep financial public links and financial emails PA-owned. Reading Ops/portal dashboards must not create/revive a document link or issue another receipt. Preserve unique Ops notifications.
- Ten minutes is the per-PA outage-email threshold, not a shutdown timer. Keep native work available, display timestamped stale data, preserve queued writes and do not invent financial success.
- Keep the two PA instances separate. Preserve their source-qualified financial records and support mixed service enrollment and separate billing entities under a customer group.
- No mandatory Ledge Top, LTDS, LTT, Operations, portal or two-instance concepts in PA's generic feature labels/contracts. Instance branding and configured external-application display names may be dynamic. Standalone PA must continue to work with managed mode off.
- Viewer source remains read-only to this task; preserve existing issue/redeem/renewal and sharing contracts. Do not remove unrelated encryption, audit or generic integration capabilities while retiring the custom Operations feature.
- Preserve concurrent work, private backups and existing local edits. Never delete client datasets or local opaque Incoming objects. No branch cleanup on `main` or `dev`.

## Work register

### Latest integrated checkpoint — September 13, unreleased

This section supersedes historical progress wording below, not uncompleted
acceptance requirements.

- The owner-requested PA onboarding presentation was rechecked against the
  current public PA controller and actual Operations recipient route. The
  local desktop/mobile browser suites passed 22/22 after a fixture-read sandbox
  rerun. The same fields and grouping render on the working recipient page;
  existing-client authorized prefill, production deployment, and live
  invitation acceptance remain open. See
  [onboarding baseline](client-onboarding-pa-layout-baseline.md).
- Independent read-only QA then expanded the local desktop/mobile form,
  lifecycle, submission and recipient-page run to 40/40 cases; Client TypeScript
  passed. This confirms local new-client presentation/route parity against the
  checked-in PA baseline, not full functional parity or a fresh live PA check.
  The recipient page still cannot receive authorized existing-client prefill;
  its public session returns only invitation ID, expiry and state. Do not
  enable that capability by adding PII to the bearer-link session.
- Native workforce `time.record` now has an inactive, default-unmounted
  revision-1 D1 command and immutable receipt (migration 0098). Focused
  full-chain D1 tests passed 8/8 after independent QA corrected ambiguous
  database outcomes and strict date validation, and an additional multi-scope
  project grant/deny regression passed; Operations TypeScript passed.
  The staging migration inventory includes 0098 and its 48 focused checks
  passed. These results do not establish an activated time workflow:
  amendments, employee submission, independent review, bonuses, native jobs,
  fuller scope/race testing, PA financial processing and production acceptance
  remain open. See [workforce boundary](native-workforce-implementation-boundary.md).
- Native integration permission execution now passes 11 full-chain D1 tests
  (`a25139`), including the transactional before-state race correction. Additional
  creator-provenance/profile/replay-race tests are running separately; their
  result is not yet accepted. The selected-staff read API and native HTTP adapter
  are implemented locally but remain unmounted pending their own tests. Root
  TypeScript passes (`866f69`). Read review caught manager/target grant confusion;
  the cross-target correction and explicit regression must pass before routing.
  No management authority is seeded. See
  [permission management](native-integration-grant-management.md).
- Staging inventory/evidence/acceptance tooling passes all 58 joined Node cases
  (`779fc6`) after adding 44 missing migration filenames and correcting obsolete
  suffix expectations. This is not release certification: the immutable
  candidate pins and live evidence remain unfinalized, with all release gates
  preserved. Detailed evidence is recorded at the end of this plan.

- Public-link handoff now checks the resolved destination origin before sending
  a fragment-bearing legacy link to the canonical portal. This rejects `//s/…`
  and similar network-path interpretations without changing normal paths,
  queries, fragments or fragmentless legacy sessions. Three routing regression
  cases were added; selected routing/lifecycle suites passed 36 tests (`db8bbd`),
  fresh Client build passed (`9a3f07`), both desktop/mobile legacy-host browser
  checks passed (`d94e39`), and Client TypeScript passed (`3aba29`). Independent
  read-only review found no actionable bypass in this bounded change. These are
  synthetic checks, not proof of live configuration or migrated-data compatibility.
- Compatibility acceptance must still join pre-existing link records with the
  final migrations and actual Worker/cookie flow, including password, expiry,
  revocation, resumed Range requests, signing-key overlap, and Incoming upload
  resume across rollout. Component test selection includes Client routing,
  public-share routes/lifecycle, bulk-download backend/concurrency and delegated
  shares; Ops incoming policy/gate/routes/security and Viewer share/session
  issuer suites. Keep effective flags and secret/key identities unchanged unless
  their explicit intended migration is reviewed; checked-in defaults alone are
  not evidence of the live state.
- Native directory list, record editor and gated Worker routes are mounted
  locally; see the current-objective evidence above. They are not enabled in
  production and do not authorize isolated deployment of legacy write retirement.
- Onboarding preserves the PA layout and contact/company/address grouping.
  Root inspected fresh desktop/mobile screenshots; all 10 recipient-form browser
  tests passed (`f4c8cf`) and Client TypeScript passed (`6b4dcf`). Field-specific
  address length errors preserve input, focus the relevant field and prevent
  submission. Exact-limit supplementary Unicode input is not silently shortened.
- Operations address paths now preserve region 100, postal code 32 and country
  100: 102 pure tests (`807fdd`), all 10 onboarding-approval D1 tests (`4c6792`),
  and an enrolled-client materialization test (`66fad3`) passed. The approval
  fixture now uses migration 0085, matching the current admission-version fence.
  Do not mistake the earlier fixture failure for a reason to weaken that fence.
- PA's local migration 0099 and strict public/API validation have targeted
  evidence in the [onboarding baseline](client-onboarding-pa-layout-baseline.md).
  Remaining review/internal-client writer and view edits await explicit owner
  authorization after a read-only-scope rejection. Do not apply those edits via
  another agent. Local Operations work can continue independently.
- Source audit confirmed project binding leaves a durable pending refresh that
  has no consumer; later updates remain blocked. The next local slice adds a
  canonical shared-project head/history and bounded refresh settlement, with
  explicit native project scopes/grants and captured current staff authority.
  Existing client/org grants cannot be treated as project rights. No automatic
  grants, inferred historical authority, or portal publication are permitted.
  The required joined project-synchronization tests are recorded in this work
  register. Implementation and independent review remain in progress.
- No production migration, PA release, Ops deployment or authority cutover is
  established by these local results. Public-link compatibility, release flag
  reconciliation, both-instance acceptance and the full remaining register stay
  release gates.

### Current integration checkpoint — enrollment and delivery (September 12)

- Native directory HTTP now includes session/list/read/edit in an unmounted
  adapter. Encrypted cursors bind current staff admission, issuer/audience,
  query and origin; the list rechecks native identity after producing the page.
  Browser session/list transport, exact routes, cursor and mock HTTP suites
  passed together: 38 tests (`e9e5fd`). Root then added bounded record-detail
  transport; its six tests passed (`5c35bd`), including wrong-record rejection,
  exact profile fields and preservation of full state names on reads.
- The responsive directory list panel exists locally. Root review caught and
  requested correction of its missing cursor argument; actual transport-backed
  desktop/mobile browser acceptance is now being added. It is not yet mounted,
  deployed or a verified replacement for the everyday Client Hub.
- Migration 0085 pins canonical writes and exact-retry authorization to the
  native admission version captured during authentication, without changing
  mutation identity. The old principal-only PATCH handler is locally retired;
  its replacement must be mounted and verified before releasing that retirement.
  Current database tests are still in progress: initial fixture failures exposed
  outdated partial-schema setup and unsupported standalone client creation,
  not passing acceptance. No live schema or PA setting was changed.

- Native everyday directory work is now tracked in
  [its integration contract](native-client-directory-contract.md). The bounded
  list/search service passed three full-chain D1 cases (`0f2d8c`) and TypeScript;
  root review requested stricter enum validation and visible-page-cap coverage.
  The HTTP boundary and confidential pagination transport are in progress,
  unmounted. Admission-version fencing and the broader read-ID versus UUID-only
  write-ID discrepancy must be resolved before claiming everyday edit readiness.
- The PA-style onboarding address audit confirmed an end-to-end mismatch:
  full state names are accepted in the form but client writes still allow only
  two characters, and postal limits differ between form and submission. The
  directory contract records the preserving generic 100/32/100 repair scope.
  Existing rejection remains in place until the coordinated schema/API changes
  are verified; PA deployment remains an owner handoff, not an autonomous step.

- Release configuration reconciliation is mandatory before deploying this branch:
  the checked-in `apps/operations/wrangler.jsonc` still has
  `INCOMING_RCLONE_PROMOTION_ENABLED: "false"`, while earlier live acceptance
  recorded the ready-folder publisher working. This is a source/deployment
  discrepancy to verify, not evidence that production is currently disabled.
  Do not overwrite working Incoming, public-link, notification or Viewer flags
  merely by publishing this migration branch. Compare live non-secret settings,
  reconcile intended values explicitly, and keep new authority gates off until
  their coordinated acceptance is complete.

- The joined signed-JWT/browser/HTTP/D1 workflow now exercises two separately
  configured PA instances (`7e2b65`, two workflows passed). One approved contact
  remains one canonical record and produces exactly two destination-qualified
  ready intents after an exact lost-acknowledgement replay. Both credentials are
  absent from discovery responses and persisted intent metadata. This remains
  synthetic acceptance, not verification of either deployed PA instance.

- Queue navigation now includes a return to Client Hub; navigation/refresh use
  secondary styling while creation and review remain primary actions. The
  fixture now loads actual shared and Operations styles. Eight desktop/mobile
  tests pass (`2ffa63`); root inspected the mobile screenshot with wrapped long
  names and no horizontal overflow. Earlier fixture screenshots lacked shared
  typography and are not the visual baseline.
- Preparation helper now passes six real-D1 cases through the full 0001–0083
  migration chain (`644500`), superseding the earlier partial-schema fixture.
  Coverage includes exact destination identity, current actor revocation,
  predecessor acknowledgement, bounded pagination, missing predecessor denial,
  and an approved business contact waiting for its organization's acknowledged
  PA identity. Root reviewed the helper and full-chain fixture setup. Remote
  replies remain synthetic; neither production instance was changed.
- The trusted dispatch-authority adapter passes four pure tests (`611905`) and
  TypeScript (`552f44`). Two real-D1 tests through 0083 also pass (`d8b2ad`),
  using approved onboarding and its stored materialization. Root reviewed the
  fixture (`4c95e5`) and requested stronger matching-candidate/config mismatch,
  same-command altered-payload and edit-revocation cases. Those expanded cases
  now pass (`2967f1`), including reallow after restoring each grant.
- A fresh production-bundle build and all 12 actual-entrypoint onboarding route
  browser tests pass. Root inspected the specs (`22f230`): invitation success,
  authorized queue and review denial/expiry are covered with synthetic HTTP.
  A successful selected-enrollment review through the actual entrypoint was then
  added and passes with the review spec's six desktop/mobile cases after another
  fresh build. Root inspected it (`3fb9db`): both new targets contain the exact
  source-qualified destination, with native session/CSRF and no legacy auth call.
  HTTP replies are synthetic; these browser cases do not prove remote delivery.
- Durable cycle checkpoint storage and migration 0084 now pass four real-D1
  tests (`4a6c1b`). It stores bounded traversal metadata, not credentials or
  customer data. Revision compare-and-swap rejects an older overlapping cycle's
  write; normal scan wrap to a null cursor remains valid. Root inspected the
  migration/store (`6fa4ad`). No deployed-schema migration occurred.
- Root added a default-off scheduled wrapper: load checkpoint, run the bounded
  cycle, and conditionally save that revision. Contention does not overwrite
  the winner or immediately repeat delivery. Unexpected failures expose only a
  sanitized diagnostic. Wrapper and cycle pure tests pass 8/8 (`e99804`); full
  TypeScript passes (`6592e0`). Independent review found no concrete CAS,
  starvation or disabled-I/O defect. The initial full-D1 joined business test
  through 0084 passes (`fa94bc`): approval, organization acknowledgement,
  linked-contact delivery and persisted progress across cycles. That initial
  case did not simulate a remote lost response. The expanded dual-instance
  case now passes (`11d351`, full TypeScript `d3c6fe`): primary commits then
  loses its response; secondary organization/contact still progress; primary
  retries byte-identical command/body and then resolves its contact. Each
  instance uses a distinct parent public ID. Four logical remote commits and
  four durable outbox rows result from five POST attempts. Only outbound PA
  HTTP is mocked. Root inspected assertions (`581d61`) and corrected a mock
  capability-GET header assumption; no runtime protocol was changed for it.
- Local Worker wiring now has a separate `1-56/5 * * * *` trigger and
  `PROJECT_ALPHA_DIRECTORY_DELIVERY_ENABLED: "false"`. It awaits the wrapper
  and returns before unrelated maintenance. Root inspected the branch
  (`7b978e`, then `8b2867`); regenerated Wrangler declarations, full TypeScript
  and four mocked actual scheduled-entrypoint tests pass. The tests check the
  literal default-off flag, awaited wrapper completion and sanitized errors;
  they do not claim a remote cron fired. No remote trigger, flag or PA
  configuration has been changed.
- Next everyday-workflow gap: existing exact-ID directory routes still sit
  behind legacy staff middleware, and the current Client Hub lists PA source
  projections rather than native canonical records. A separate native scoped
  list/search primitive is now being implemented, followed by native session,
  detail/profile-edit HTTP and a usable Client Hub shell. Preserve old `/clients`
  projection routes and their public-link behavior while preparing the single
  authority cutover. Native onboarding must ultimately navigate back into that
  canonical shell, not require a legacy PA-derived staff login.

- The protected browser enrollment transport is implemented with correlated,
  bounded, immutable responses and no credential fields. Parent source review
  confirms exact identity/hash binding and unique configured source identities.
- The decision builder now accepts explicit selected configured sources for new
  targets and leaves existing target enrollment server-owned. Its 11 pure tests
  pass (`a68529`). The expanded joined test passes (`9b6ceb`, two workflows):
  actual discovered choice to builder to HTTP to D1 creates exactly one ready
  intent with the selected source/app/origin/instance/epoch and permanent record
  ID. Exact approval replay after lost acknowledgement does not duplicate it.
  This verifies queued intent creation, not remote PA delivery.
- Joined browser transport, signed native JWT, real HTTP handler and synthetic D1
  tests pass (`7364b0`, two workflows). New assertions cover pending queue
  visibility, removal on committed approval despite a lost acknowledgement,
  hiding rows after view permission revocation, and enrollment discovery denied
  until enrollment-management permission exists. The response contains no PA key.
- The scheduled Worker does not yet compose directory materialization, leased
  dispatch and acknowledgement reconciliation. An isolated bounded delivery-cycle
  composition is the next implementation step, followed by durable checkpoint
  storage and explicit rollout gating. The enrollment review UI now passes 16
  desktop/mobile component cases after expiry and pagination corrections; the
  built-entrypoint acceptance gap is specified above. None of this is a
  production release claim.
- Required delivery behavior: bounded selection; exact deployment source/app/
  origin/instance/history identity; durable command identity across retries;
  acknowledged parent before a linked contact; sequential reconciliation; and
  a separate default-off rollout gate. A missing parent must never become an
  unlinked contact, and changed epochs must never silently retarget work.
- Current dispatch rechecks the original actor's current native authority.
  Revocation can therefore pause an approved write. Keep that denial intact and
  provide a reviewed reassignment/reconciliation path rather than dispatching
  using old PA roles or historical approval alone.

### Latest checkpoint — client onboarding (September 12)

Current transaction implementation decisions (not a release claim):

- The preserved-parent version regression now passes with the full eight-case
  decision suite (`ecb2d8`). A further real-D1 destination fixture passed
  (`15a57c`): business approval creates distinct parent/contact intents, pins
  the client dependency, blocks child materialization until parent acknowledgment,
  then uses the exact acknowledged PA organization public ID.
- Added the dedicated, default-off `POST /api/client-onboarding/admin/review-options`
  handler. It uses version-pinned native authentication, CSRF, a 4 KiB input
  limit, current permission checks and private responses; it needs no invitation
  decryption key. HTTP/routing tests passed 24 cases (`5619be`), including
  caller-supplied authority rejection and expiry during the read.
- Review-choice service tests passed three real-D1 cases (`7e819c`) for
  complete-scope organization filtering, deny precedence, current target and
  parent revisions, search/cursor, revoked authority, decided invitations and
  no mutation or credential disclosure. A separate `currentOrganization`
  supplies the authorized parent even when absent from the search page.
  The additional missing-relationship-head test passed (`b13f26`); the
  joined signed-JWT HTTP flow including actual review options also passed
  (`575b94`, two cases). Fresh TypeScript passed (`6415a0`).
- Staff command construction and bounded browser review-choice transport are
  being connected to these contracts. The full staff review UI, explicit new
  PA enrollment preview and production onboarding rollout remain unfinished;
  native-only customer creation must continue to support an explicit empty
  destination list.
- The browser review-choice transport now validates a dedicated current parent,
  coherent ID/version correlations, bounded profiles, and paginated organization
  choices. Its owner reports 5 focused and 29 related pure transport tests
  passing; these do not replace the real-D1 evidence above. The deterministic
  native-only decision builder passed seven pure tests (`931220`) for new,
  existing, preserve, unlink/reparent and rejected commands. Its rejection
  command is being decoupled from organization-option loading; rejection still
  requires the server's current decision authority, not merely permission to
  view a submission. No SQL permission broadening is authorized by this UI work.
- The actual staff review component is now in implementation, using the
  existing review/options/decision endpoints. It must preserve one finalized
  command for unknown-outcome recovery, hide private review data on session
  expiry, and require explicit confirmation. A canonical invitation-only staff
  review path helper is prepared; route mounting waits for the component and
  browser acceptance. Recipient secrets must never appear in this staff URL.

- September 12 continuation: approval plus migration-chain tests passed eight
  cases (`671f0b`); focused new-contact/new-organization and existing-contact/
  new-organization paths also passed (`7bc7ab`, `89d492`). These used synthetic
  local D1 data, not either production PA instance.
- Independent review found that preserving an organization link did not
  correlate the supplied previous parent revision with the parent revision
  being edited. The service and migration now require an existing parent with
  that exact current revision; the browser validates the same condition.
  The historical link-time revision is not incorrectly treated as current.
  The database regression is pending its runner slot; browser transport and
  review tests passed 24 cases (`fdfa33`), and TypeScript passed (`e3699f`).
- A signed-JWT/browser-transport/real-D1 acceptance test is now implemented for
  invitation issuance, recipient submission, staff review, approval and lost-
  acknowledgment retry. It asserts one durable decision and no implicit PA
  enrollment. Both joined tests now pass (`bfcae7`), including pre-decision
  denied view/foreign actor and revoked link authority on receipt replay.
  The initial run reached approval but had an incorrect test expectation that
  revoking link permission also removes independent view permission; corrected
  tests verify each permission separately. The positive PA parent-intent
  dependency fixture remains explicit acceptance work.
- Rechecked the client form directly against PA: preserve its established field
  order, labels, conditional company-contact panel and 680px card. The layout
  baseline now points to the current portal component path. This does not
  imply the new production onboarding link or staff review UI is finished.

- Migration 0082 requires every newly finalized client write with PA intents to
  include an immutable organization-link dependency in the same transaction.
  An explicit unlinked decision is distinct from missing relationship evidence.
  Historical unpinned intents are preserved for reconciliation, not backfilled
  from today's organization state.
- Existing parent mappings require protocol-validated command and acknowledgment
  evidence pinned to the exact source, application and history epoch. A pending
  parent intent may be recorded as a dependency, but child dispatch must wait
  for its verified acknowledgment.
- Migration 0083 and the approval service are being implemented with a separate
  immutable decision receipt. The reviewer needs current native authority;
  possession of the public invitation is not reviewer authority. An expired
  public link does not erase an already submitted proposal, but a revoked
  invitation must block a new approval.
- Root extended the migration-chain regression through 0082, including populated
  historical records and assertions against invented relationship dependencies.
  All three extended real-D1 tests passed (`e3833d`), including the populated
  history preservation check. This proves the local schema chain, not the
  approval service or production migration.
- Root review identified two store-integration corrections before acceptance:
  remove schema-detection fallback to the old client-write behavior, and pin
  the current organization revision for a new client update rather than require
  the organization to remain at its original link-time revision. Also test
  pending child dispatch after an ordinary parent mapping update. These fixes
  and behavioral regressions remain with the dependency implementation owner.
- Four pure dependency-input tests passed (`26b255`): explicit unlinked binds,
  accessor/hidden-key rejection before SQL preparation, invalid or missing
  relationship evidence, and rejection of a claimed mapping without a valid
  protocol receipt. These test input construction only; transactional authority
  and parent-update liveness still require the focused real-D1 suites.
- The expanded pure dependency-input suite passed six cases (`fab9c9`), adding
  separate parent/child intent revision binds and preservation of destination
  values after caller mutation. No database authority claim follows from mocks.
- Approval-service review identified required cases before its first acceptance
  run: explicit preservation of an unchanged relationship; coherent current
  authorization for submission reads and receipt retries, including inactive
  scope parents; dependency on the same-batch organization intent for an
  existing organization update; and a permission-checked new organization when
  reviewing an existing individual client. Implementation remains in progress.
- Mapping clarification: current PA directory mappings are immutable and retain
  their establishing command; a later profile update adds a new outbox command
  rather than replacing that mapping command. The parent-revision store defect
  is separate. Pending-child tests must reflect this actual mapping lifecycle,
  not simulate an update forbidden by the database.
- Parent-receipt input coverage now accepts a complete synthetic acknowledgment
  and rejects changed source instance, application, history epoch, public ID,
  revision and external identity. The joined field/command/dependency suite
  passed 18 tests (`f2bef8`). The first fixture incorrectly assumed every
  profile field must be echoed verbatim; it was corrected to the actual identity
  contract. Exact original command/outcome storage binding remains a SQL gate.
- The existing default-off native admin HTTP adapter is being extended with
  review/decision routes, separate from secret reveal. These require server-
  derived version-pinned authentication and retain CSRF, bounded input and
  unknown-write-outcome recovery. Mocked transport acceptance does not replace
  the upcoming joined decision-service/D1 tests.
- The browser transport now reads staff-authorized submission reviews through
  the fixed same-origin endpoint, validates the invitation/hash/version and
  target/scope envelope, and returns detached immutable data. It rejects
  browser-supplied authority and unexpected secret fields without automatic
  retries. Existing invitation transport plus new review tests passed 17
  (`0d09c9`); joined worker-adapter and both browser transport suites passed
  30 (`c72329`). These are mocked transport tests, not proof of a completed
  approval transaction, a mounted review UI or production enablement.
- Initial 0083 synthetic D1 acceptance passed three focused cases (`57a6a2`):
  migration application, authorized review/rejection/retry with current denial,
  and atomic new unlinked contact approval/retry without PA enrollment or portal
  grants. Linked/preserved relationships, expanded permission races and late
  rollback remain separate gates. The general historical-preservation chain
  test has now been extended through 0083 and awaits its run.
- Root's full 0083 schema review requested explicit per-client scope presence
  (not merely some target scope), canonical timestamp rejection of SQL NULL,
  and consistent decision UUID validation. These are being addressed before
  broader approval acceptance. The upgraded 23-case directory-store fixture
  now targets 0082 and is running separately from the decision suite.
- Root added a deferred-read review-expiry regression. It binds valid native
  authority, advances time past the original deadline while the database read
  is pending, and attempts to extend the caller-owned deadline. The detached
  authorization fix passes this test (`50d413`); it does not substitute for SQL
  scope/revocation tests. The first upgraded store run passed 21/23; remaining
  fixture corrections cover required admission revision increments and changed
  denial ordering, with a full rerun still required.
- Expanded browser review tests verify cancellation of an oversized streamed
  response without trusting Content-Length and rejection of already-aborted
  requests. Joined with the authorization-lifetime regression, eight tests
  passed (`f820dc`).
- Expanded 0083/chain run passed six of seven cases (`9492c1`); approved-contact
  replay exposed incomplete SQL in the grant-coverage predicate. Read-only
  SQLite compilation reproduced it (`5a0c67`), and the missing closing
  parenthesis was restored without removing authorization checks. Real-D1
  replay must pass again before this gate is considered verified.
- The corrected current-0082 store suite now passes all 23 tests (`00ce70`),
  and global TypeScript passes (`6825e9`). It preserves create-race coverage
  using organization records, composes new client fixtures with explicit
  relationships, and exercises existing-client writes/replays through the real
  standalone store. The new dependency suite separately passed seven D1 cases
  (`9ab859`). Browser decision transport is prepared with exact receipt
  correlation, no automatic retries or ID regeneration; its coordinated pure
  suites passed 47 tests. The 0083 database rerun is still a separate gate.

Native authentication now offers a version-pinned result for transactional
approval/relationship writes. Identity and admission version come from the same
primary read; existing authentication return shapes remain unchanged. Focused
signed-JWT tests passed 13 (`762826`), real-D1 identity/auth tests passed 13
(`e4a087`), and TypeScript passed (`80b4ab`). This provides the captured version;
each later write must still compare it against current authority in its batch.

Relationship schema/writer 0081 now passed seven local real-D1 cases, together
with three migration-chain tests (10 total, `c986e9`). Independent QA identified
missing native-record enrollment checks and weaker UUID validation; both are
fixed. Replay authority is checked in one primary read with the captured staff
admission/profile versions and a post-read deadline check. The chain through
0081 verifies no implicit relationship creation or staff admission. The
onboarding contract now spells
out the separate immutable approval decision ledger and required single-batch
composition. Approval endpoints, parent-dependent PA materialization and live
cutover remain incomplete. No production configuration or public links changed.

Reviewed-form projection and reusable immutable canonical command validation
passed 11 joined pure tests (`fa15c5`); current Ops TypeScript passed (`1d2b1f`).
These preserve contact/company separation and existing receiver limits without
silently truncating long states. All 21 existing directory-store D1 regression
tests passed (`4ee421`) after the validation extraction. Six additional targeted
ACL cases passed (`bf4251`): resource, assigned, area and division allows,
former-parent denial, and inactive scope-parent veto. The full relationship
suite passed 13/13 after the division fixture change (`7beece`).

The canonical write-plan builder now exposes write and finalization stages for
the future single approval batch, while its existing wrapper retains the full
sequence. All 23 directory-save real-D1 tests passed (`c6cfb3`), including keeping
the live write fence available to dependent statements and rolling back after
a late failure before finalization. These stages are server-only construction
primitives, not a complete approval service. Immutable per-client-intent PA
relationship dependencies are now under implementation; no production migration
or source-authority cutover has occurred.

Approval foundation increment: deterministic directory write planning is now
reusable without moving validation or authorization out of the existing store.
All 21 real-D1 store tests passed (`1c156d`), including composed organization and
contact writes plus complete rollback after a late failure. Independent review
found no SQL ordering/binding regression. This proves composition of the existing
record writes, not the missing reviewed-decision/relationship transaction.
PA already supports explicit organization references; its parent-link semantics
are documented in the onboarding contract. Ops now checks requested parent
identity in live/stored PA acknowledgments (51 protocol tests, `987a15`).
Typecheck passed (`38d6bc`). Next: durable reviewed relationship storage and a
separate exact-destination parent dependency, with SQL-fenced materialization.
Joined materialization/PA transport regressions passed 66 (`1a733b`). No
production enablement or cutover occurred.

Latest increment: the native staff invitation screen is mounted at exact
`/clients/onboarding/invitations/new` before the legacy PA session bootstrap.
Its reserved admin API namespace is mounted with default-off native controls.
The authenticated session supplies the configured recipient origin, validated
against the complete portal origin list; the panel no longer accepts an origin
override. Actual built-page and panel browser tests passed 18 (`76a2a7`), joined
routing/HTTP/transport/native-JWT/real-D1 tests passed 28 (`016ceb`), and Ops
build/typecheck passed (`23dbd5`, `0d95e0`). Recipient PA-parity browser suites
passed 38 (`ee415f`). All of this is local synthetic acceptance, not a release.
Client Hub discovery/navigation, atomic organization/contact approval, PA
materialization and address compatibility, required secrets, deployed acceptance
and the coordinated authority cutover remain incomplete. Prior checkpoint
details below describe the sequence, not current production availability.

Final UI QA pinned each in-flight invitation's recipient origin across staff
refresh, while retaining exact-command recovery, and aligned browser existing
client target validation with canonical UUIDs. Final browser acceptance passed
20 (`c881f9`), transport tests passed 12 (`d434a2`), and build passed (`8e1fc0`).

The PA-style client form, invitation opening, bounded HTTP transport, immutable
submission ledger, current-scoped invitation issuance and dedicated request
quotas are locally implemented through migration 0079. The joined HTTP/quota /
0001–0079 chain passed 20 tests (`23c62e`); the page passed eight desktop/mobile
tests (`8e5415`) and TypeScript passed (`f23fea`). These are synthetic local
checks, not a deployed client onboarding link. Migration 0080 now adds encrypted
client-link recovery and audited reveal. Its full 0001–0080 migration chain
passed three tests (`20e361`); the final joined handoff/issuance/submission suite
passed 22 tests (`bc3b96`) and TypeScript passed (`768143`). Staff HTTP
session/create/reveal and browser adapters now pass 15 joined unit tests
(`27fdec`) and TypeScript (`d641fb`). Signed-JWT/real-D1 browser-to-handler
acceptance now passes (`840107`), including a lost post-commit response followed
by exact retry, audited reveal and revoked/foreign authority denial; TypeScript
passes (`ee2c4b`). Scoped issuance option loading is being implemented for the
Client Hub, rather than asking staff to enter raw database identifiers.
Recipient frontend mounting now uses the Client app's exact `/client-onboarding`
entry route. The PA-style layout is preserved; Client build and 22 pure tests
passed, 36 desktop/mobile browser tests passed, and the expanded real-entrypoint
page suite passed 12 tests. Local private Ops service binding configuration and
recipient backend routing are locally mounted behind disabled flags, not a
staff-host public-access exception. The private dispatch boundary passed ten
unit tests and Client routing/platform/domain compatibility passed 67 tests
(`7e9445`). Actual local two-Worker/D1 recipient acceptance now passes, including
both portal origins, submission and exact retry, through the real private
entrypoint. The joined options-D1/HTTP/browser suite passed 26 (`43383d`), with
Ops typecheck passing (`fd2211`). This caught and fixed a D1 UUID-pattern limit,
Workers redirect-mode mismatch and a numeric Client entry-module export;
subsequent bulk/routing regressions passed 45 (`c3f8c2`). Deployed binding and
Cloudflare Access acceptance remain unproven. The isolated staff invitation
panel passed 12 desktop/mobile tests (`97d28e`), but the Client Hub issuance
action and staff HTTP routes are not mounted yet.
Scoped review/canonical approval, recipient-verified prefill, notification
delivery and public mounting remain.

Staff onboarding is a separate workflow: its later checkpoints below supersede
the older 0075-only checkpoint that follows. Local 0076 staff creation/reveal and
signed lifecycle tests exist; production admission/cutover remains incomplete.

### Earlier native-staff checkpoint (historical)

September 12 checkpoint: the isolated pending-invitation Access verifier is now
locally implemented, with eight signed-token/race tests passing (`6fcdd1`) and
TypeScript passing (`b89960`). It preserves exact identity subjects and a dedicated
audience without calling staff admission. The subsequent local HTTP slice mounts
the exact session/claim/status paths behind an explicit disabled flag, with
claimant CSRF, bounded JSON and primary-database quotas (0075). The final joined
regression passed 25 tests across six files (`b09996`) and TypeScript passed
(`2b2f74`). The isolated claimant page is now locally implemented; its final build
and TypeScript checks passed (`a2e256`, `1d359b`), with 32 desktop/mobile browser
checks passing (`e071b8`) including the existing Viewer shell. Screenshots were
visually reviewed. These are synthetic browser fixtures, not live acceptance.
The administrator invitation review reader is also locally implemented, using a
bounded current-authority snapshot and returning approval pins without secrets.
Final real-D1/pure review and approval regression passed 30 tests (`317a25`), with
TypeScript passing (`1335cd`). The reader writes no identity or authority.
A separate native staff request authenticator
is now implemented locally: staff-only signed assertions resolve exact approved
native identities without legacy email binding, and expiry is checked after D1.
The initial joined authentication/identity regression passed 12 tests (`53595c`);
the final staff/claimant authentication and identity regression passed 31 tests
across six files (`99dc27`), with TypeScript passing (`184438`).
The exact administrator session/review/approve/cancel routes now use this
authenticator behind `NATIVE_STAFF_ADMIN_ENABLED=false`, with empty configured
origin, separate admin CSRF, bounded JSON and domain-separated 0075 quotas.
Final joined admin lifecycle, routing and authentication regression passed 30
tests across six files (`0f247d`); TypeScript passed (`50dfd7`) and generated
bindings matched (`5ce6bc`). Current command authorization remains separate from
authentication. No create/delivery endpoint exists yet. None of these slices is
deployed or enabled.
M04 still requires live isolated
Access policy, invitation delivery, management UI, recovery and reviewed native-login
cutover. See the [staff management plan](native-staff-management-plan.md#http-integration-boundary-local-implementation-disabled).

The rows are implementation packages, not a gradual production authority handover. Multiple packages may be developed in parallel; production ownership switches once at M09 after compatibility and recovery acceptance.

| ID | Work package | Current state | Exit evidence |
| --- | --- | --- | --- |
| M00 | Decisions, ownership matrix and current objective | Recorded; architecture decisions confirmed | Decision file plus this register; no unresolved business choice hidden in code |
| M01 | Incoming maintenance release and waiting-upload recovery | PR47–50 merged; readable-folder deployment recorded; waiting ZIP recovered; owner confirmed hourly ready-only pickup. Fresh September 14 repository-owned deployment readback shows `ledgetop-ops` version `3548a141-968b-4c37-9605-185c4f6d9f58` at 100% with `INCOMING_RCLONE_PROMOTION_ENABLED=true` and `R2_INCOMING_BUCKET_NAME=ltds-incoming`; source-commit attribution and fresh end-to-end pickup remain unproven. Upload-form export approval and live friendly-name/email acceptance remain | Controlled publish/read/MOVE and received-email check; conditional access-code/responsive form release |
| M02 | Versioned generic API contract and retirement inventory | Directory command contract locally joined-tested with instance/application fences; read/change-feed and remaining domain contracts open | Resource ownership/scopes, application identities, revision/idempotency/error/change-feed semantics, all old consumers accounted for |
| M03 | Generic PA safety and write foundation | Local scope/application/managed-policy, directory commands/bindings/reads, readiness preview/initialization command routes and attachment changes have targeted evidence. PA's latest full local PHPUnit suite passes 1,231 tests / 9,075 assertions / 96 skipped; two additional no-database front-controller bootstrap-route cases then passed in a five-test / 42-assertion routing selection. Guarded onboarding/membership/department/import paths are included; see [writer inventory](directory-authority-migration.md). Owner-controlled activation/return UI, capable-writer proof, full writer coverage, joined HTTP/MySQL and release remain open. The MySQL script attempt was stopped by Windows script-execution policy; it did not run. | Generic API/managed-policy/retention MySQL and standalone HTTP acceptance; neutral docs/labels; deliberate owner activation only after writer proof |
| M04 | Canonical Ops identity and staff admission | Native identity, scoped management, invitation lifecycle, encrypted staff handoff and default-off HTTP/quota have local evidence through 0076; see later signed lifecycle and UI checkpoints. Live policy, complete grant management, administrator bootstrap/recovery, normal native login, reviewed backfill and production acceptance remain open | Source-qualified customer/unit/billing/worker maps; local staff admission; scoped role/deny/transfer tests |
| M05 | Two-origin projects and operational time/review | Generic project core, default-off HTTP adapter, Ops transport and atomic command provenance tested through joined HTTP/MySQL. Inactive Ops workforce ledger (0096), default-deny authority (0097), atomic initial time-record command (0098) and submit/review command (0099) have local D1 evidence. Exact native-staff time-record, own-entry read, submit, review and session routes are mounted before legacy auth under one independently default-off gate with blank origin. The combined time-record, submit/review, self-history and HTTP/router suites pass 46/46, including revoked-grant-before-write, identical-submit race, beneficiary-only pagination and active-admission checks. A direct-only `/time` page locally supports beneficiary-only history, internal self-entry and explicit draft-only self-submission for manager review without legacy auth fallback. Its submission retries keep the exact command and require same-staff reauthentication; a confirmed receipt removes the draft action even if history refresh fails. Live 401/403 clears private history, 409 disables stale submission pending refresh, and an unresolved submission blocks new keyboard form writes. Operations TypeScript and build pass, focused desktop/mobile browser acceptance passes 24/24, and the focused existing HTTP/D1/self-history backend suites pass 30/30. A separate default-off direct `/time/review` manager queue and reasoned approve/return UI now pass 22 focused D1/HTTP/routing tests and 6 desktop/mobile browser cases; the local Operations build passes. Both staff UIs remain unlinked in navigation and disabled by default. Project/job/on-behalf entry UI, PA-local writers, durable consumer/UI, job authority, bonuses, governed grant bootstrap and finance processing remain open. No deployment or time-capture activation is claimed | Duplicate/lost-response/conflicting-edit tests; shared project identity; project/job/internal time, on-behalf records, bonuses, independent review and end-to-end release acceptance |
| M06 | Financial views, pricing/compensation, billing recipients, notifications | Read-only PA/Operations audit confirms no generic v2 financial document or action-link read API yet. Legacy list scopes are broad and omit stable public IDs/link state; legacy public-link creation/view paths may mutate state, so neither is a safe portal read adapter. PA generic read-only per-document capability, whole-document billing authorization and pure link-status read must precede Ops projection/UI. No PA source was edited in this audit | Authorized document-level reads, no link-on-read mutation, explicit pay policies, no duplicate financial mail, outage/recovery tests |
| M07 | Unified client experience, website/reporting and Hermes API | PA-style onboarding form, recipient transport, recoverable issuance/reveal, native review queue/approval and explicit PA enrollment have local HTTP/D1 and mounted browser evidence. Directory delivery and checkpoint composition are tested through 0084, with dual-instance lost-response acceptance underway. These are not production acceptance. Canonical everyday Client Hub, invitation notification, unified service journeys, website/reporting and Hermes remain open | Service-specific client journeys, responsive hub/admin, report provenance/review, scoped and attributed agent commands |
| M08 | Legacy-link/Viewer compatibility and migration rehearsal | Fresh independent QA passed 82 Client tests across six public-share, lifecycle, delegated-share and ranged-download files. Three focused Operations suites passed 21 tests. `viewer-public-share-routes` initially could not start because local `@cloudflare/containers` resolution failed; after that package was restored, a root retry still could not load Vitest config because esbuild was denied ancestor-directory access by the sandbox. It is not counted. Earlier broader public-link baseline passed 129 focused tests. These are synthetic/local checks; deployed old-link, real R2, cross-domain cookie, migration/restore and Viewer acceptance remain pending | Valid old links still work; deny/expiry/password and resume hold; migration/restore preserves records and Viewer grants |
| M09 | Published PA update handoff and coordinated production cutover | Not started; owner deployment gate required | Both PA revisions verified; private backups rehearsed; old writers fenced; new authority joined acceptance |
| M10 | Custom integration retirement, final acceptance and cleanup | Pending after M09 | No active hidden legacy writers/config/credentials, docs current, accepted workflows on both domains; only approved safe branch cleanup |

September 14 M06 source audit: PA `origin/main` at
`51e333fb2ca2e26248b3f96588b8c126f4a2832b` exports only directory,
project, service-location and job records through its v2 snapshot. Its
unversioned quote/invoice lists have broad scopes, session-based row filtering,
internal numeric IDs and no existing-action-link or billing-allowlist proof.
Ops has no bounded v2 quote/invoice/contract adapter; its current quote
verification call to `/api/v1/ops/artifacts/verify` has no matching route in
that PA `main` snapshot. This is a source-contract gap, not proof about a
separately deployed PA revision. PA's `pa_public_link_active()` is a pure
existing-link lookup; `pa_public_link_status()` and link creation may mutate
link state and must not be reused for portal reads. The first safe M06 code
slice is a generic, GET-only, exact-scope quote summary with dedicated API
capability, explicit client/project billing authorization and existing active
link or null, followed by a bounded Ops adapter. It must neither create links
nor send financial mail. Contract/invoice reads and per-document allowlists
follow after quote authorization tests; no PA code was changed in this audit.

September 14 PA branch reconciliation: the generic API implementation is local
and uncommitted in `C:\Projects\Project-Alpha\.worktrees\cron-preflight-diagnostics`,
not in PA `origin/main` or a published release artifact. That worktree includes
untracked migrations 0088–0099, generic service/route tests and reference docs;
its branch is ahead of the verified PA main by six commits and behind by one.
The primary PA checkout is an unrelated, dirty recurring-expenses branch.
Preserve both worktrees; before PA release, archive the API worktree including
untracked files, then selectively carry reviewed slices onto a fresh branch
from verified `origin/main`. Do not reset, rebase or infer deployment from the
local worktree. The PA owner deployment/sign-in gate still applies.

September 14 M05 follow-up: local internal on-behalf time capture is now wired
behind the existing default-off native workforce gate. Migration 0108 adds an
unseeded exact actor-to-beneficiary selection delegation; its allow/no-deny
fence is checked in the same D1 batch as the existing on-behalf work-context
grant. The exact Worker ID lookup also requires both authorities and returns
only ID/display name or a generic 404. The `/time` UI confirms one Worker ID,
keeps private history self-only, and generation-fences session/history reads
after independent QA found a stale-identity race. The six focused backend
suites pass 51/51, the desktop/mobile time page passes 34/34, Operations
TypeScript/build pass, and staging preflight/evidence tests pass 46/46 with
0108 in the required inventory. No mounted delegation issuance exists yet;
job context, correction/bonus, PA workforce APIs, owner
approval policy and live acceptance remain open. This is **not** activation,
deployment, or production capture.

September 14 M05 project-context follow-up: the local `/time` form can now
search and select a native Operations project for either self or an explicitly
authorized on-behalf beneficiary. The read endpoint is bounded and mirrors the
POST authority predicates, including active actor/beneficiary admission,
native grant scope and denial precedence, and exact selection delegation.
It exposes no PA/legacy project catalogue or broad staff listing. The focused
HTTP/D1 suites pass 22/22 (including a searchable 26th project and denied
cross-scope cases), Operations build passes, and the desktop/mobile time-page
suite passes 38/38 after independent QA's project-only on-behalf selection
gap was corrected. This remains behind the default-off native gate; it is
local evidence only, not permission to start production time capture. The
picker intentionally duplicates the executor's authorization predicate for
safe discovery; any future predicate change must update and test both, while
the atomic POST fence remains the final authority.

September 14 M05 governance follow-up: unmounted migration 0109 and its
Operations-only executor define an exact actor-to-beneficiary selection issuer,
separate from the broader 0101/0102 capability issuer. It is unseeded,
version-fenced, deny-precedence and auditable with an idempotent receipt in
one D1 batch. No route or UI mounts it. Independent review found and the
implementation fixed stale-authority reactivation guards. The complete
five-case Miniflare suite now passes, including issuance/replay, stale/deny
rollback, four authority races, identity collision, and reactivation guards.
At this checkpoint, no normal revoke/reactivate command was yet available;
the separate 0110 lifecycle checkpoint below supersedes that implementation
gap, but does not authorize mounting the issuer. Staging inventory then
included 0109, and the 46 preflight/evidence tests passed locally. Nothing
here authorizes staff to issue a delegation in production.

September 14 M05 selection-lifecycle follow-up: unmounted migration 0110 and
its unmounted Operations executor add separate exact actor-to-beneficiary
revoke/reactivate authority for the 0108 selection. The D1 transaction binds
current actor/beneficiary admission versions and subject, selection version,
exact lifecycle delegation and operation/effect ceiling, deny precedence,
immutable audit and an actor-bound idempotent receipt. Independent read-only
security QA found no concrete privilege or atomicity flaw; the expanded
Miniflare suite passes 8/8, including stale-version/denial races, deactivation,
subject rebinding and lost acknowledgement. The staging migration inventory
now includes 0110, and preflight/evidence tests pass 46/46. No route, UI,
seed, feature activation, staging migration or production grant was added.
Governed grant bootstrap and end-to-end revocation acceptance remain open.

September 14 repository check: the generated Client Worker declaration was
reconciled to the current onboarding flags and private recipient service
binding. `npm run check:worker-types` and the full root `npm run check` now
pass. This fixes type-generation drift, not a staging or production rollout.

September 14 M01 regression check: eight focused Incoming/TrueNAS suites pass
58/58 tests covering ready-folder promotion, planning, reading, reconciliation,
retention, upload notifications, archive browsing and routed access. They
exercise local Worker/D1/R2 fixtures, not the actual hourly TrueNAS MOVE or
the owner's email inbox. Retention remains unchanged.

September 14 M01 deployed-configuration readback: Wrangler's ten most recent
`ledgetop-ops` deployments show version
`3548a141-968b-4c37-9605-185c4f6d9f58` at 100% (deployment time September
11, 13:44:50 UTC). Read-only version metadata reports
`INCOMING_RCLONE_PROMOTION_ENABLED=true`, the expected Incoming host, and
`R2_INCOMING_BUCKET_NAME=ltds-incoming`. This proves the named deployed
configuration, not that GitHub `main` commit `60c6af70` produced the binary,
nor a fresh object-to-TrueNAS transfer, email receipt, or retention result.

September 14 M01 current-main reconciliation: after refreshing `origin/main`
to `60c6af70d330e39e97f9e7742e56510f84895cb0`, all ten PR47–50 Incoming
overlap files are present in the integration worktree. Readable contributor/
date folder planning, journal-key stability, collision prevention, truthful
pickup-status wording and the production promotion binding/cron are retained.
The production promotion flag was reconciled to the live/main `true` value;
staging remains default-off. The three focused planner/promotion/status suites
pass 34/34. An independent read-only cron review found exact dispatch and
default-off pre-D1 guards for the three local non-Incoming schedules. The
directory and onboarding schedules share four minutes/hour (11, 26, 41, 56),
so deployment review must either accept that invocation/load explicitly or
shift one schedule and rerun routing tests. Current source parity is not a
fresh TrueNAS transfer or a production release of the other migration work.

September 14 presentation recheck for M07: the earlier comparison against the
local PA working branch `b847852b` was stale. The verified remote PA `main`
revision `51e333fb2ca2e26248b3f96588b8c126f4a2832b` is the source-code
layout baseline: a segmented Individual/Organization choice first, followed by
contact details, conditional organization details, and billing address. The
Operations recipient form now follows that flow while retaining its
required personal email, optional general-company contact fields, and safer
fragment invitation transport. Client TypeScript check and build passed;
the four focused desktop/mobile browser suites were rerun and passed 42/42
after the correction. Desktop and narrow-screen captures were visually
inspected. Source parity does not prove live staging/production parity or
complete client onboarding acceptance; see
`client-onboarding-pa-layout-baseline.md`.

Later rerun after the September 14 worktree updates: the two focused
recipient-form/page suites pass 26/26 on desktop and mobile. A computed-layout
regression confirms the 680px desktop card, paired email/phone rows, and
single-column mobile stacking without horizontal overflow. The segmented
choice browser test now clicks its visible label, as a user does; Playwright's
programmatic radio `.check()` was intercepted by the PA-style decorative
label span despite working pointer and keyboard interaction. The first run
also hit a local sandbox fixture-read denial, so the passing rerun used the
existing dependency tree with approved access. No production behavior or
onboarding authorization changed in this rerun.

September 14 M07 responsive-navigation follow-up: the Operations Client Hub
already has tested 1/2/3/4-column detail bands and a final full-width portal
danger row. The client portal's all-projects grid now uses one column on phones,
two from 640px, three from 1120px, and at most four from 1800px. Client
TypeScript/build and eight focused desktop/mobile browser checks passed,
including 3440px no-horizontal-overflow. Client team-management
revocation/suspension controls remain inline with their individual records;
broader client navigation, service journeys and live acceptance remain open.

### M01: immediate Incoming rollout

- Completed evidence: PR47 merged into `main` at `6752ee2cf8f69bdb8221f7b02a6a68962eb3f28d`; exact PR-head pre-merge CI and post-merge run 34537003386 both passed all ten checks. Fresh focused local Incoming tests passed 39/39 across four files. Dated limits remain recorded in this work register.
- Current owner-confirmed state: TrueNAS selects `ready/` and its hourly PULL/MOVE task is resumed. Preserve the current destination; no extra server scanner/agent. Earlier paused-task instructions were superseded by this confirmation.
- Verify Cloudflare's deployed revision before claiming a release is live. Initial publication was default-off; the active checkpoint below now records the approved PR48 activation and exact deployed bindings.
- Confirm private staging and exclusive ready publishing, the unchanged retention policy, migration state and the original pending-upload object identity. Never label an absent object "downloaded" without independent evidence.
- Latest owner decision: leave bucket retention unchanged for now; do not add the proposed 14-day `ready/` deletion rule. Keep existing application access expiry and quarantine rules unchanged. Rclone MOVE is the normal ready-object cleanup; an uncollected ready object has no new automatic physical-expiry fallback. Do not silently install one or claim access expiry deletes stored bytes.
- The waiting upload was recovered with explicit one-time network-drive permission. Its exact size was 893,398,388 bytes (about 852 MiB); the ZIP contained 43 JPGs and one MP4. A separate `Incoming Job Data/iCloud Photos.zip` copy matched SHA-256 and all 44 entries passed CRC verification. After explicit conditional deletion approval, only the original opaque object and its two now-empty upload-specific directories were removed. The shared quarantine folder and recovered ZIP remain. The owner confirmed the recovered ZIP is good. This is manual recovery evidence, not a fabricated application/server pickup receipt or malware verdict.
- Cloudflare reported active Operations version `1feb9d5c-b41a-46aa-8d96-87694cb6441f`, created September 10 at 22:23:19 UTC, including the Incoming promotion Workflow binding. Exact source correlation and activation checks remain distinct from this version readback.
- Created and read back a zero-byte `ready/` folder marker in `ltds-incoming` so the owner could select that prefix in TrueNAS. This was not client-upload or publication proof and changed no lifecycle rules, customer objects or publishing flags. The owner subsequently confirmed the selector and resumed the task.
- Fresh GitHub fetch confirms PR47 head `ba56d72` and merge `6752ee2` have identical tracked trees. Remote read-only D1 inspection confirms migration `0213_incoming_rclone_promotion.sql` and all three basic-check/journal/outbox tables exist. Active Worker version readback confirms the correct Incoming bucket and Workflow bindings, SMTP notifications enabled, and promotion flag still `false`. No new migration or flag change was performed during these checks.
- The owner confirmed the `ready/` selector is saved **and resumed the hourly TrueNAS task**. This supersedes the paused-task status above. Publication stayed disabled until approved PR48 activation; do not assume the server is paused for a test. No root/quarantine pickup is authorized. Any future controlled upload test must account for the next hourly MOVE and record object identity before pickup.
- Review clarified that the promotion's 14-day checks implement the existing application upload deadline (the older lifecycle already waited 24 hours plus 13 days). They are not a new R2 ready-prefix deletion rule. Native TrueNAS uses only Cloud Sync; legacy scanner/receipt-worker configuration and its POSIX tests are not prerequisites for this mode.
- The first agent multi-filter command did not execute every intended file; its broad claim was discarded. Reliable direct individual Vitest runs subsequently completed 13 native Incoming suites: **109 tests passed, zero skipped/failed** (71 promotion/dispatch/read/retention tests, 16 staff ACL-route tests, 22 ZIP directory/inventory tests). Type checking passed. Legacy POSIX pickup-worker test skips do not gate native Cloud Sync. An isolated activation release is being prepared; no publishing flag has been changed yet.
- Isolated activation commit `3331a62f7047ba92a61a7fc24dfc2ddaf31f8978` changes only the flag and rollout runbook, based on merge `6752ee2`. Parent reviewed and pushed it, opening [PR48](https://github.com/ledgetoptechnologies/LedgeTop-Ops/pull/48). Typegen/typecheck and 30 source/config checks passed locally. CI run `34546318599` is in progress for that exact head; no merge or live activation has occurred. Existing dirty reminder/configuration edits remain outside this release.
- Do not reverse the existing TrueNAS MOVE task to PUSH. If a re-upload is needed after confirming the original, use a separately scoped one-time COPY with the exact destination and identity recovery verified first. Preserve the server original; a new R2 upload is not automatically the same object version as the missing one.
- Activate in the coordinated window, recover only still-present eligible original uploads, and exercise a controlled upload with authorized staff browsing/download. Basic checks remain bounded and are not an antivirus verdict.
- Confirm ready-only TrueNAS pickup with the already-resumed schedule. Absence after MOVE means no longer in R2, not a fabricated pickup receipt. Previously moved originals must be recovered from the existing local copy if needed.

### M02–M03: generic API and PA prerequisites

- Start from the [source-backed interface foundation](api-first-interface-foundation.md). It distinguishes the current legacy key/snapshot/event behavior from the replacement design; it is not a published API contract.
- Inventory each existing custom connection responsibility: staff admission, business snapshots, workspace hierarchy/identities/denials, catalog, assignments, service requests/drafts, notifications, operational projects/jobs and external worker references. Give each a replacement owner or an explicit retirement decision.
- Define generic capabilities and per-resource scopes for directory, organization units, projects, workforce records, financial reads/actions and integration administration. Separate tokens per PA instance; separate Hermes principal from the Ops-to-PA connection.
- Introduce stable application identities, safe rotation/revocation, scoped object access, durable request receipts and compatible schema migrations. Token replacement must not erase idempotency or management ownership.
- Specify one durable change-feed/consistency mechanism for PA-created/edited projects and financial observations. Include cursors, revisions, tombstones, origin/echo suppression, pagination, retry/backoff and explicit conflict review. Do not disguise the removed custom integration as another hidden mandatory connection.
- Close the audited PA project-deletion gap before the new write API depends on safe retention. Existing invoices/contracts/history and file references must not disappear through a cascade or filesystem cleanup. Check all applicable controller and future API paths.
- Exercise standalone PA onboarding/imports/forms as well as managed mode; lock guards must cover non-UI writers. Old security primitives may be reused, but old authority paths cannot keep writing after cutover.

### M04–M07: canonical workflows

- Customers: Ops-managed profiles/onboarding, typed customer units, explicit billing entities and durable mappings to each applicable PA. Portal profile changes use verified identity rules, not an email change that transfers membership.
- Projects: shared name/ID, optional project on one-off requests, client proposal versus approved work, one PA mapping, source-qualified automatic creation in either system, conflict-aware edits, protected history, personal hiding and permitted organization archive.
- Staff: Operations accounts and business-area/division/resource scopes; a PA login is optional and separately managed. Show effective access and preserve global denies.
- Time: project/operation or general/internal work; actual actor versus beneficiary; revisioned submission, independent review, returns/corrections and audited on-behalf entry. Bonuses are explicit adjustments, not fake hours. Do not erase worked-time history when returning a submission.
- Finance: PA prices/pay rules and definitive document status; fixed/hourly/base-overage/none policies independent of role; keep client billing and worker compensation separate, including batching and corrections. No automatic pay on submission or approval.
- Billing: individual allowlists with customer defaults, local additions/removals and global revocation; future-only new grants unless historical access is deliberately confirmed. Check complete documents spanning multiple work scopes.
- Portal: one service-aware dashboard on either portal domain, safe dynamic greeting, relevant drone/website sections, explicit delivery sharing, existing history and requests. Keep financial actions in PA and internal notes private.
- UX: preserve compact dynamic search, 1–4-column responsive client details, client workspace subnavigation, clear danger zones, folder counts, current-folder sharing and recent-link filtering.
- Websites/Hermes: inventory/service enrollment, website review/edit request workflow, manual-first monthly reports with real provenance, and scoped agent API with audit/idempotency/approval boundaries. No fake uptime/security statistics or owner impersonation.

### M08: public-link preservation acceptance

- Establish fixtures for existing legacy and current-host links before migration. Use synthetic tokens, not customer bearer URLs, in artifacts.
- Rehearse migrations with unchanged verification keys/token hashes and explicit stable ID mappings. Compare link count, scope, expiry/revocation, password requirements, manifest/object identity and ownership before/after privately.
- Verify old hostname redirects retain exact path/query and do not loop, strip capability data or add login requirements. Test current portal hostnames separately.
- Test folder navigation, immediate-child counts, public downloads, bulk ZIP64 generation/cache reuse and Range/If-Range resume; test revoked/expired/password-required counterparts too.
- Verify no stale cache or adapter fallback bypasses a revoked link or a changed object. Existing authorized bytes must not turn into a different customer's bytes through ID remapping.
- Perform production smoke checks only with appropriately authorized test links; avoid downloading real large customer datasets merely to inspect a page. Any actual target upload retrieval is a separately identified task.

### M09–M10: owner handoff, switch, rollback and retirement

- Prepare verified PA updates with exact candidate revision, migration prerequisites, test evidence and backup instructions. Stop for owner review **before PA merge/release** under the latest authority boundary. After approval/publication, the owner updates **both** PA instances and signs in. Do not mark the migration complete at either handoff.
- Preserve working production connections until the replacement and all consumers are ready. Preparation on isolated data is allowed; competing normal customer editors in production are not.
- Rehearse backups and restores of both PA databases and all affected D1 stores/configuration, without publishing credentials or private exports. Resolve ambiguous records before opening canonical writes.
- Use a bounded maintenance window and explicit writer/version fences, including the old staff reconciler. Distributed changes are coordinated and recoverable, not an invented cross-database atomic transaction.
- Prove both business paths, a shared customer, revoked member, individually identified client, Ops-only employee and preserved public link before general availability.
- Before new real business writes, the frozen-state rollback is available. After writes/emails/financial actions, reconcile the durable ledger and fix forward or use the tested reverse migration; never blindly restore old databases over new work.
- Retire every custom Operations setup/runtime/cron/route/config path and obsolete narrowly scoped credentials after the replacement passes. Preserve historical audit records, encryption and unrelated generic features; AlphaLedger's migrated PA financial functionality is not obsolete data.
- Finish website/Hermes and all retained acceptance work before declaring the overall objective complete. Inventory old PA branches only at the end; never remove `main` or `dev`.

## Active implementation checkpoint

- Parent: updated objective/work register, Incoming retention decision and release evidence; recorded the initial API interface/consumer inventory.
- PA prerequisite: independent review found omitted planning, portal authority and financial/history dependencies; parent also identified public-link/child-project and derived-schedule distinctions. These checks were added, including rejection of missing project IDs before filesystem cleanup. Parent reran the corrected guard and related project UI/routes with `--do-not-cache-result`: **48 tests, 815 assertions passed**, exit 0. Source/diff checks pass. MySQL non-FK concurrent-writer behavior and live HTTP acceptance remain unproven release gates; no full retention/migration acceptance is claimed. No production writes or PA release yet.
- API inventory identified additional required work: remove ambient browser-session dependence from token handlers, explicitly bind application/token/resource authority, freeze legacy scope expansion, and prove committed change-feed ordering. These are tracked in the interface foundation; no existing token was broadened and no PA connection was changed.
- Local API scope increment adds explicit policy versions: legacy keys retain a frozen capability set; newly created keys use exact catalog scopes. Unknown/malformed policies fail closed, including authentication without a requested-scope list. Empty-scope schema repair is restricted to legacy policy. Agent validation: 43 tests, 545 assertions, 3 skipped across scope, snapshot, notification relay and security-hardening suites; migration file validation passed for 88 files. These are local results awaiting independent review, not database migration or HTTP/live acceptance. Application identity, expiry, resource filters and write APIs remain incomplete.
- An independent scope-policy review found no concrete blocking issue. Full PHP-suite validation is running separately. Direct public-ID project writers now acquire parent locks before their durable writes; related tests reported 54 total, 422 assertions and seven opt-in MySQL skips (47 executed). The parent identified a further current-workspace recheck requirement after a concurrent project move; that is being addressed before treating the writer package as ready. No MySQL concurrency execution or PA production acceptance is claimed.
- The current-workspace recheck is now implemented: project-first then current-parent locking reads reject a concurrently reparented project before access writes. Updated local suite: 56 total, 425 assertions, eight environment-gated skips (48 executed/passed). Initial sandbox Docker access failed; sanctioned elevated read-only diagnostics then confirmed a running local Docker engine and an already-installed `mysql:8.4` image. A disposable MySQL test run is being arranged; do not treat the prior skipped cases as passed.
- Follow-up executed all eight project locking/current-read cases against disposable **MySQL 8.4: 8 passed, 29 assertions, zero skips**. The corresponding non-MySQL focused suites passed 48/48 with 425 assertions. The test runner prohibits image pulls and checks exact container name/ownership label before cleanup; a final check confirmed no matching test containers remained. No production database was used. This closes the identified direct-writer concurrency test gap, not every future mutation/migration requirement.
- The full PHP suite completed with exit 0: 825 total tests, 6,684 assertions, 94 environment/optional integration skips, zero failures. These skips are not completion evidence. File-level migration validation passed for 88 files. A separate MySQL scope-policy migration test and the next durable application/token-expiry foundation are in progress; full replacement APIs and managed-directory mode are still not implemented.
- Ops compatibility baseline: six focused client suites passed 129 tests plus 9 preflight checks, covering public routes/lifecycle, legacy routing, authorization, file and bulk Range/If-Range behavior. Source/release invariant tests passed 35/35. No customer tokens or production download. An accidentally broad local browser invocation is not counted as completed acceptance.
- Local application identity/expiry migration 0089 is now present but under lifecycle/authentication review. The disposable MySQL 8.4 scope-migration test caught unsupported `ADD COLUMN IF NOT EXISTS`; 0088/0089 syntax was corrected. Follow-up must verify actual runner sequencing, ledger reruns, runtime-repaired schemas and interrupted-DDL recovery. The identity foundation is not a usable administration UI or complete replacement API, and neither PA instance has received these changes.
- The follow-up migration rehearsal passed **4 MySQL 8.4 tests, 43 assertions, zero skips**. Metadata-guarded DDL supports replay at all five durable 0089 boundaries, runtime schema repair before migrations, ledger reruns and preserved legacy/exact scopes. The isolated harness uses real migration-library helpers but reconstructs the apply loop; it is not the full production CLI/backup/restore rehearsal. Container cleanup verified empty afterward. Application lifecycle tests and independent credential-policy QA continue separately.
- Live Incoming browser inspection confirmed staff can open the upload browser and Joe's record, which honestly reports no private object available and offers no archive/download. The old list still says awaiting verification and counts this reservation under awaiting pickup. Source review also found queued outbox records can claim basic checks passed before checks run. A separate local wording/count patch is in progress; do not change the verified PR48 head for it. PR48's exact CI run currently has nine successful jobs and the Operations test job still running; it has not been merged or activated.
- PR48 CI run `34546318599` subsequently completed successfully: all ten jobs passed for exact head `3331a62f7047ba92a61a7fc24dfc2ddaf31f8978`. The approval system rejected the attempted merge because it requires PR48-specific authorization beyond PR47. No merge/deployment was performed; an explicit permission question was sent to the owner. Do not bypass this by direct deployment or another merge surface. Unaffected local API implementation continues.
- The owner explicitly approved PR48 and its Cloudflare deployment. PR48 then merged successfully at `63425fc9758bb37037eb14ba181eb8f586e21636` (September 11, 00:37:22 UTC). Fresh fetch proves the merged tracked tree equals tested head `3331a62`. The first post-merge deployment read still showed old active version `1feb9d5c`; build/deployment verification is pending, so activation is not yet claimed.
- Cloudflare build `f417102a-b643-4ad8-b5dd-c7e679f6884f` subsequently succeeded for merge `63425fc`. Parent Wrangler readback confirms active deployment `938e15c0-8818-4dac-8ff9-cb6675c60c02`, version `11bc24af-b36d-44b9-b6d9-808fef136987` at **100%**, created September 11, 00:39:11 UTC. Version bindings confirm Incoming bucket `ltds-incoming`, promotion Workflow, publication flag `true`, and SMTP notifications enabled. No manual deployment/restart was needed. This proves activation, not upload/MOVE/email acceptance. Post-merge GitHub CI run `34547269404` is separate and remains tracked.
- API application lifecycle foundation now passes 25 tests/64 assertions, including all four mutators under audit failure in owned and caller-owned transactions, disabled-app revocation, rotation identity/hash-only persistence, invalid scopes/actor and expiry. Parent reviewed the expanded tests and requested the disabled-app and malformed-scope cases. Generic admin wiring is the next local implementation task; PA remains unreleased.
- Separate honest-status/count patch is local only: pending/copying no longer claim basic checks passed, reservation totals no longer imply pickup-ready files, and explanatory text distinguishes reserved capacity from bucket contents/receipt. Build and typecheck passed; 12 unit tests and 12 actual desktop/mobile browser tests passed after rebuilding stale local assets. This four-file patch is not in PR48 and is not deployed.
- The honest-status patch is now isolated and published as [PR49](https://github.com/ledgetoptechnologies/LedgeTop-Ops/pull/49), exact head `e3042e041133dc85e81bcc6883db1f760a46f5d4`, based on merged PR48. Parent reviewed the four-file change; isolated build/typecheck, 12 unit and 12 actual browser tests passed. CI/release remains pending; no change to publication, storage or authorization logic.
- PR49 CI live handle is `34547955923`, exact head `e3042e0`, initially in progress with no failures. Do not restart it due to observation timeouts. Notification source review confirms successful completion records the authorized owner digest independently of native promotion; scheduled delivery and SMTP gates are separate. Existing tests cover aggregation, authorization failures and retries, but do not prove actual inbox delivery or TrueNAS receipt.
- PR49 subsequently passed all ten jobs. Parent verified the exact reviewed head and merged with a head-match guard under the owner's goal-duration Ops release permission. Merge commit: `80bc4e053449f69d5aa5dbf086a691455bc32916`, September 11, 01:00:10 UTC. Cloudflare deployment acceptance is separate; no manual deploy or CI bypass was used.
- PR49 Cloudflare build `0810e732-b6f2-4934-a5fe-03b3c32a0d1b` completed successfully. Parent readback confirmed active deployment `30e8d158-67c1-411b-8e70-8d0027ff56b4`, version `a63760cc-9fcb-4448-8b92-d5829455ddee` at 100%, created September 11, 01:02:09 UTC. This completes PR49 build/activation tracking; the later form/naming changes are not part of that release.
- The owner was asked to provide a small non-sensitive test upload and confirm the next hourly local arrival plus email receipt. These human-visible endpoints cannot be proven by R2 object disappearance. The live staff upload page remains accessible after activation; no real client file was re-uploaded or marked delivered.
- Sync global ordering primitive now uses a transaction-held singleton source lock before resource/event writes and snapshot checkpoints. Existing sync tests passed 8/8 with 138 assertions; dedicated real three-connection MySQL tests passed 2/2 with 10 assertions, covering delayed commit, blocked second writer/checkpoint, rollback gap and replay after the committed cursor. Full mutation coverage, paginated snapshot convergence and HTTP acceptance remain gated. Generic durable command receipts are the next local foundation, not an enabled replacement consumer.
- Credential-policy QA now exercises the actual production pure predicate used by API authentication: missing/disabled/revoked application, malformed/expired/exact-bound credentials and legacy compatibility. Focused combined run passed 14 tests/70 assertions. This is not HTTP/session-cookie acceptance, rate-limit validation or proof of durable audit behavior on response exits; those remain explicit follow-up work.
- Controlled upload follow-up: the owner's small MP3 appeared in the live staff browser as **Ready for server pickup**, with its private object present (5.5 MB). The authenticated Download file action was exercised without a browser-tool error, but the tool supplied no completed-download receipt or byte/hash evidence. Local TrueNAS arrival and actual notification-email receipt still need owner confirmation. Do not infer receipt from subsequent object disappearance. This supersedes the earlier not-yet-tested upload status, not the outstanding end-to-end gates.
- The owner subsequently confirmed the MP3 **downloaded to the local server through the hourly task**. This is actual human-confirmed pickup evidence, not inference from R2 absence. Email receipt remains unanswered. The owner requested readable folders based on the submitted contributor name instead of request/upload IDs. A separate path-planning change is now in progress for newly journaled uploads: sanitized name, persisted upload date and a short stable discriminator, original safe filename. Existing journal paths/publication fences remain immutable; no existing object is renamed or republished, no retention change, and TrueNAS remains at `ready/`.
- Owner screenshots exposed an inline dropzone layout defect and an access-code input on an unprotected public link. A separate Incoming form patch is in progress: responsive block layout, centered primary actions, and conditional rendering from the server-resolved link requirement. Server code enforcement must remain intact. Do not amend the already-running PR49 head with this change.
- The form fix now has 12 focused page/route tests, including real correct/wrong access-code checks, plus eight desktop/mobile browser cases. A genuine failed-upload/reload/reselect case verifies the same persisted client upload ID is reused. Parent visually reviewed synthetic desktop, narrow protected/widget-placeholder, and long-filename mobile screenshots. Real Turnstile verification is not claimed from the placeholder fixture. Final isolated release checks and PR preparation are in progress, separate from readable-folder naming.
- Final form release candidate is isolated at `Incoming-Form-Access-Code`, branch `codex/incoming-form-access-code`, commit `15fe0c1a77a1da4f3c50ac8961f1cdbe5f04bb77`, based on PR49 merge `80bc4e0`. Exactly five intended files; isolated 12 page/route and eight browser tests, typecheck, production build and diff checks passed. Parent reviewed source diff and rendered screenshots. Push/PR was explicitly rejected by the platform as source export needing informed payload/destination approval despite the broader Ops permission. No retry through another surface, push, PR or deployment was performed. Ask owner approval for this exact export to `ledgetoptechnologies/LedgeTop-Ops` on GitHub before publishing. This is not evidence of a code failure or a three-turn overall-goal impasse.
- Generic API-key administration is now wired locally to the application lifecycle service. The latest focused agent run passed **70 tests, 562 assertions, three existing skips**. Parent review caught an exact-IP versus CIDR contract mismatch; administration now reuses the actual authentication allowlist parser and rejects invalid/CIDR entries without partial mutations. Service scopes use explicit catalog membership, not a read-only suffix inference. The UI still exposes only its current offered capabilities; replacement write routes are not implemented. There is no reusable HTTP controller harness, so service/source tests are not claimed as complete admin/CSRF HTTP acceptance.
- A parent combined run exposed a test-order assumption that no PHP session was already active. The pure credential test now verifies unchanged session status/content with both empty and administrator ambient data, restoring prior global state afterward. The stable application/scope/admin/sync selection passed **51 tests, 334 assertions**; in-progress command edits were excluded from this checkpoint. This strengthens pure-function isolation, not HTTP cookie acceptance.
- The local generic command-receipt foundation (migration 0090) passed **12 SQLite tests, 41 assertions**, plus **one real MySQL test, seven assertions, zero skips**. Tests cover canonical key ordering, conflicting list order, bounded depth/size, caller-owned transactions, authority recheck on replay, and current receipt reads after a stale MySQL snapshot. Parent requested token/request/actor attribution before endpoint wiring; that refinement is in progress. No new API endpoint is enabled and no PA release has occurred.
- Command attribution refinement is now local: trusted typed context, independent current token/application/expiry/policy checks, immutable first-success provenance and successful per-attempt provenance across token rotation. External actors are explicitly application-asserted, never PA users or privileges. Denied/rolled-back-attempt auditing remains a route responsibility. Agent MySQL rerun passed one test/eight assertions, zero skips, with exact disposable-container cleanup confirmed. Parent reran the combined application/command/scope/admin/sync selection: **64 tests, 383 assertions, zero skips/failures**. No endpoint or PA release is implied.
- The subsequent full PA PHP suite completed with exit 0: **876 total tests, 6,856 assertions, 94 optional/environment skips, zero failures** (782 executed). This supersedes the earlier 825-test baseline for current local changes. Optional skips are still not acceptance evidence, and no PA release or production migration is implied.
- Local readable-folder implementation passed 19 Worker/D1/R2 tests plus Operations typecheck. Parent source review requested persisted-date fixtures that do not expire after 14 days and old copying-state coverage; both were corrected. An independent consumer/path review is now underway. Only the four owned rclone source/test files and a separately isolated runbook naming hunk belong to this change; the preexisting dirty runbook must not be published wholesale.
- Independent readable-folder review verified persisted-key consumers and 10 read tests, but found the new full destination path lacked a bound. The fix now budgets the relative path to 220 UTF-8 bytes, preserving useful extensions and leaving room for the currently configured destination roots; arbitrary deeper roots are not guaranteed. Parent reviewed the fix and preservation of the legacy sanitizer/planner, then reran plan/promotion/read: **32 tests passed**. Parent separately ran seven workflow/retention/reconciliation/outbox/driver/dispatch/summary suites: **48 tests passed**, for **80 tests across ten files**. Operations production build passed (existing large-chunk warning); agent typecheck and parent diff check passed. The naming patch remains local, with only its four source/test files and isolated naming documentation hunk intended for release; no naming release or existing-file rename has occurred.
- The first generic stateless PA capabilities endpoint is implemented locally with an exact early route before browser sessions, app-bound exact-scope authentication, safe JSON failures, and mandatory usage persistence. Parent found SQLite-specific SQL was prepared before the MySQL branch; this is now corrected by selecting the SQL before prepare. Agent's final validation reports seven SQLite tests/41 assertions and two disposable MySQL 8.4 tests/11 assertions with native prepares, covering rate limiting, revocation, source identity, persistence rollback and safe 503. Disposable-container cleanup was verified. Parent review of the added MySQL harness and actual front-controller HTTP acceptance remain open. No PA release, replacement authority cutover, or complete mutation API is claimed.
- Open operational gates: actual upload-email receipt, final naming/form release and post-release acceptance. Deployment/source correlation for PR48 and PR49 is complete as recorded above; the owner confirmed hourly ready-only TrueNAS pickup. The form export still needs the platform-required informed approval. TrueNAS is already resumed; tests must account for the hourly MOVE. The waiting ZIP recovery and prefix creation are complete. No new bucket expiration rule is authorized or required by the owner's current choice; existing application expiry remains. These do not block isolated API foundation work.
- Generic API wire acceptance advanced locally: seven real MySQL/loopback-HTTP tests, 46 assertions, now execute the actual PA front controller and prove disabled-before-DB behavior, cookie independence and usage rollback after a later write failure. Parent reviewed the harness, source adapter and exact disposable cleanup boundary. Legacy routes are source-checked rather than all executed; no cutover is authorized from this evidence alone.
- Operations now has an unwired generic-API preflight consumer with bounded metadata, pinned installation UUID, no redirects/cookies, required no-store and classified errors. Independent Sol review identified and confirmed fixes for scope-versus-endpoint readiness, origin-root routing and cache freshness. Parent ran **32 tests** and Operations typecheck successfully. No scheduler/configuration or production source authority was changed.
- M04 directory writer inventory is recorded in [directory-authority-migration.md](directory-authority-migration.md). Client and organization controllers now keep profile/address changes in one transaction. Tax-file removal/replacement cleanup waits for successful completion and skips cleanup while a caller-owned transaction remains active. The strengthened test checkpoints actual profile/address/assignment rows before an exact injected projection-phase fault, using a narrowly translated SQLite upsert; separate source contracts detect old controller ordering. This is not full controller/attachment HTTP acceptance. Parent reran the generic API and projection suites together: **34 tests, 510 assertions**, all passed. Parent independently reran the disposable MySQL/HTTP harness: **7 tests, 46 assertions**, all passed; filtered container readback was empty. Runner now restores previous environment values. Managed-directory policy, real directory command routes and whole-writer enforcement remain incomplete.
- Full PA validation subsequently completed with exit 0: **886 total tests, 6,909 assertions, 94 optional/environment skips, zero failures** (792 executed). This supersedes the previous 876-test local baseline; skipped integrations are not acceptance evidence. No PA release or production update occurred.
- No automatic goal completion, no implied PA production update, and no claim that public-link production acceptance has already passed this migration.

### Directory authority / immutable identity implementation checkpoint

- PA migrations 0091/0092 now define explicit application resource grants and
  immutable external-resource bindings respectively. Baseline and migration
  health registration are updated. Neither seeds authority nor activates a
  route. PA users administering grants must currently be active, nondeleted
  administrators; ownership alone does not broaden access.
- Parent review corrected binary identifier comparisons in 0091, and required
  0092 to recheck exact-policy, active/future-expiry credentials and isolate its
  mapping/audit changes with a savepoint. A failed audit cannot leave a mapping
  behind when the caller catches the error and commits unrelated work.
- Generic command target identities now preserve whitespace/case and up to 191
  valid UTF-8 characters (764 bytes), consistent with immutable mappings. No
  natural-name/email matching or implicit account merge is introduced.
- New strict directory command input validation distinguishes create/update,
  explicit nulls and omissions. A supplied address is a full six-field
  replacement. Private PA notes, tax/provider configuration and financial
  records remain outside shared-profile commands.
- New generic directory projections include organization email/phone and public
  relationship IDs. They use independent `directory_client` and
  `directory_organization` version metadata because the legacy snapshot omits
  fields that must be revision-protected. Existing legacy hashes and IDs are
  not rewritten. The old producer is still scheduled for retirement at the
  coordinated cutover, not indefinite dual-authority operation.
- Mutation revision assertions check current locking metadata and full profile
  hashes, reject missing backfill/stale edits/deleted identity reuse, and retain
  a sequence-before-domain lock discipline. Independent Sol review found no
  primitive correctness defect but noted that correct caller lock order and
  coherent backfill must be enforced during real route wiring.
- Permanent generic project bindings and binding history are now part of the
  project deletion guard. Tests distinguish unrelated resource types/IDs; real
  MySQL confirms a binding writer retains the project-row lock against deletion.
- Parent final focused validation: **93 tests, 482 assertions**, all passed.
  Parent independently ran disposable MySQL: sequence/revision **4/16**,
  resource authority **4/12**, mappings **1/18** (tests/assertions), all exit 0,
  no skips. Filtered Docker readback confirmed all three labeled test-container
  families empty. Scope/binding runners preserve prior environment values.
- Sol is now implementing organization create/update service composition using
  these prerequisites. It is not an enabled public write endpoint. Remaining:
  real authenticated routes, exact-grant administration, client write commands,
  whole-writer ownership fences, backfill/cutover rehearsal and owner-reviewed
  PA deployment. Incoming form/naming source export still awaits informed
  approval; no publish, production schema change or link mutation this turn.

### Organization command adapter and incoming follow-up checkpoint

- Organization create/update now compose current credential/resource checks,
  revision checks, immutable bindings, profile/address changes, events and
  receipts transactionally. The new actual HTTP command adapter is explicitly
  default-off; migration 0093 adds bounded authenticated rejection audit records.
  Client commands and managed-directory writer fences remain incomplete. This
  checkpoint does not authorize enabling the experimental route in production.
- Parent independently ran organization service acceptance on disposable MySQL:
  **1 test, 52 assertions**, including duplicate-name rollback. Corrected agent
  HTTP acceptance reports **2 tests, 42 assertions**; parent rerun remains due.
  The correction matters: database overrides must win over fixture defaults to
  genuinely prove disabled-before-database behavior.
- The later full PHP run terminated with **959 tests, 7,190 assertions, 94 skips
  and one failure**, in the projection writer source contract. This is not a
  green release baseline. Sol is investigating that requirement and the newest
  typed credential-denial regression coverage; no PA release occurred.
- Owner-confirmed hourly pickup remains recorded above. Parent rechecked the
  name-first path wiring and reran both planning/promotion suites: **22 tests
  passed**. New paths start with the sanitized submitted uploader name, then
  persisted date plus collision-resistant reference, then safe original filename.
  Existing journal keys and downloaded files remain untouched. Naming and form
  fixes are still local pending the specific GitHub source-export approval;
  uploaded-email receipt and post-release name-first pickup remain unverified.

### Client commands and capability-editor follow-up

- Generic client create/update now has a real default-off HTTP adapter sharing
  the organization command boundary. Its exact `directory.clients.write`
  capability does not inherit from organization write or frozen legacy aliases.
  The capability registry advertises both routes only when explicitly enabled.
  Root verified scoped authorization, immutable IDs, no name/email merging,
  full-profile revisions, address snapshots, safe retries, archived-client
  replay denial and unchanged private PA fields.
- Parent found and guarded a hierarchy consistency edge: moving/detaching a
  client requires authority over its old and new organizations and cannot
  silently orphan or delete department-contact assignments. Such assignments
  yield a reconciliation response until the dedicated hierarchy workflow is
  implemented. This is an outstanding activation gate, not a final substitute
  for the agreed organization-unit synchronization.
- The API-key editor had hidden write scopes and would remove them on ordinary
  metadata edits. Its controller also normalized away invalid posted scopes.
  Sol implemented an explicit assignable capability list, strict pre-normalization
  checks, visible preservation of existing restricted capabilities, and an
  explicit block for unknown stored scopes. Root reviewed the code and reran
  policy/editor helpers: **22 tests, 78 assertions**. Full authenticated admin
  form/CSRF submission is still an acceptance gap; helper/source checks do not
  prove that entire browser workflow.
- Parent combined directory/legacy-projection/capabilities/policy selection
  passed **65 tests, 782 assertions** before the last department guard test;
  subsequent guard/client/adapter/projection selection passed **44/615**.
  Parent independently ran expanded disposable MySQL with the actual front
  controller: **3 tests, 61 assertions**, all passed. The labeled test-container
  listing was empty afterward. These tests use isolated synthetic data only.
- Full PHP verification under session `33825` finished successfully: **986 tests,
  7,347 assertions, 94 skips**, zero failures. This baseline predates migration
  0094 and its local-writer guards; it is not final managed-directory acceptance.
  No PA commit, production migration, owner deployment or source export
  occurred. Remaining work includes read/change APIs, managed ownership and all
  writer fences, grant administration, hierarchy workflows, backfill and the
  coordinated two-instance cutover with public-link acceptance.

### Managed-directory ownership foundation

- PA 0094 adds a default-local, revisioned management policy and transactional
  audit, registered in the baseline and schema-health inventory. Assignment
  requires explicit current-admin confirmation, a current exact-policy key with
  both directory-write capabilities, complete directory resource grants, and
  successful create/update command evidence for both resource types. This is a
  prerequisite check, not proof of backfill or all-writer readiness.
- Both generic command services enforce the selected application before their
  resource/domain mutations and cached receipt replay. Revocation or disabled
  feature gates do not silently reopen local editing. Explicit audited return
  to local management remains possible without the old credential.
- Parent independently ran actual front-controller acceptance on disposable
  MySQL: **4 tests, 76 assertions**, including actual 0094 migration reapplication,
  activation from real command receipts, rejection of another application,
  sticky ownership after key revocation and explicit administrator restoration.
- Local client create/update now acquire the management guard inside their
  transaction before mutation. The combined policy/client/organization/adapter/
  legacy-projection/security selection passed **86 tests, 1,124 assertions,
  3 skips**. These are not full authenticated local-controller HTTP tests.
- Migration-library/baseline selection: **11 tests, 40 assertions, 2 skips**.
  The two baseline tests require an available MySQL backend and were skipped;
  this result does not establish a fresh full-baseline installation.
- Generic PA policy documentation now records sticky ownership, recovery,
  lock ordering, and incomplete activation gates. Client archive/restore and
  organization creation fences are the next bounded implementation increments.
  Onboarding, processor imports, mixed financial/profile paths, hierarchy,
  administration, backfill and Ops reconciliation still require implementation.
- Incoming name-first planning/promotion was independently rechecked by Terra:
  **22 tests passed**. User confirmation proves the old-path hourly pickup, not
  email delivery or name-first production behavior. Naming and upload-form CSS
  changes remain unpublished pending explicit GitHub source-export approval.

### Local archive/restoration and organization-create fences

- Client archive/delete, purge and restore now acquire the local management
  guard before their projection/domain locks. The restore service independently
  enforces it before locking or consuming an archived record. Existing retention
  and stable-identity behavior is preserved. Parent focused rerun including
  policy, directory commands and legacy projections: **77 tests, 827 assertions**.
- Full and quick organization creation now enforce the guard in their mutation
  transaction, with generic externally-managed errors. The full form does not
  store its optional tax file before the guard. Parent review caught that the
  legacy address-schema helper could implicitly commit through ALTER TABLE;
  creation now uses a read-only schema-completeness preflight and fails safely
  if migrations are incomplete. No submitted address fields are silently dropped.
- Terra focused organization/client guard tests passed **4 tests, 22 assertions**.
  Controller wiring is source-checked, not authenticated browser acceptance.
  Parent full PA PHPUnit session `56895` completed successfully: **1,003 tests,
  7,404 assertions, 94 skips**, zero failures, 3m53s. This verifies the available
  suite against the current 0094 and local-writer candidate; skipped backend
  checks, authenticated local forms and full production cutover remain unproven.
- No PA release, production policy activation, Ops publishing, retention change,
  or public-link mutation occurred in this increment.

### Organization-form regression and staging access checkpoint — September 10

- Parent reran the current organization form, directory/private-field separation,
  organization deletion guard, portal projection, client onboarding and client/
  organization layout selection: **47 tests, 674 assertions**, zero failures.
  This is focused local evidence, not a replacement for full-suite, authenticated
  multipart/CSRF, filesystem-failure or production acceptance. The preceding full
  suite predates the organization profile/private-field form split.
- Staging browser sign-in succeeded at `pa-staging.ledgetoptechnologies.com`.
  The account reached mandatory Terms acceptance; the owner must review and
  accept it before further authenticated browser testing. No acceptance was
  submitted on the owner's behalf. The visible application revision was
  `59e8644`; this does not prove the local migration candidate is deployed.
- The owner supplied a staging access guide. It describes separate staging
  containers, volumes and credentials, but isolation and disabled production
  email/payment side effects still require verification before write tests.
  Credentials are deliberately omitted from this record.
- A credential-free GET of the supplied control API `/health` returned HTTP 200
  with `healthy: true` and an upstream application HTTP 302. This establishes
  endpoint reachability only, not migrations, scheduler health or API readiness.
- The guide describes unauthenticated restart/rebuild/down/up controls and full
  Docker inspection. Those capabilities were **not invoked or verified**.
  Protect the control API with authenticated, scoped access before using it;
  full inspection and logs may contain secrets. Do not collect them wholesale.
- The guide says staging auto-rebuilds from mutable `dev`/`cron` image tags.
  Record and verify exact web/cron/migration revisions before acceptance; the
  uncommitted local candidate is not present merely because staging is healthy.
  Supplying staging access does not waive PA publishing/production review gates.

### Exact directory readiness and independent review follow-up

- Ops now has an unwired, read-only directory readiness probe requiring both
  exact POST command paths and their exact capabilities from PA's implemented
  registry. A different endpoint advertising the same scope no longer satisfies
  this directory check. Ambiguous duplicate route declarations fail closed.
  Parent focused tests: **40 passed**, Operations TypeScript check passed, and
  owned-file diff checks passed. No scheduling, credential/configuration change,
  directory writes or production activation occurred.
- Terra independently reviewed the local PA organization-form changes. Parent
  source inspection confirmed the existing `serve_upload.php` file handler
  checks session presence for organization attachments without looking up their
  organization or current attachment mapping. Retired file cleanup is suppressed
  best-effort unlink; a failed unlink can leave an old URL readable. Treat
  organization-scoped attachment serving, retired-file denial and cleanup-failure
  handling as pre-release requirements. Full front-controller authorization and
  filesystem-failure tests are still needed; this is not a completed remediation.
- Terra also identified cached/session role use in the tax handler's in-transaction
  authorization callback. Do not claim this proves immediate role revocation.
  Establish current database authority and test revocation before activation.
- The owner explicitly authorized using the staging control API as provided for
  now despite its documented unauthenticated exposure. A read-only `/status`
  check returned healthy running web/database containers, running cron, and a
  migration container exited with status 0. Web/migration use `:dev`, cron uses
  `:cron`; exact image revisions remain unverified. No inspect/log dump, restart,
  rebuild, data mutation or Terms acceptance was performed.

### Completed local verification checkpoint

- The PA full-suite rerun completed successfully: **1,013 tests, 7,468
  assertions, 94 skipped**, exit 0. This supersedes the earlier failing run:
  the organization address assertion now targets the extracted form component,
  with rendered checks preserving the suite address and an intentionally blank
  state. Skipped integration tests remain acceptance gaps, not passing evidence.
- Parent reran both Ops API readiness/command transport suites: **64 tests
  passed across two files**. The command adapter snapshots the persisted request
  before awaiting readiness, validates acknowledgements separately from write
  input, and treats ambiguous post-send outcomes as uncertain. It remains
  unwired; this is mocked transport evidence, not a live PA command rehearsal.
- The fresh readiness GET is not an atomic source-identity condition on the
  following POST. Producer-side identity enforcement and joined contract tests
  remain prerequisites to enabling directory writes.
- Staging may be used as supplied under the owner's temporary authorization.
  This does not resolve its exposure, accept its Terms, establish side-effect
  isolation, or authorize production changes. The organization attachment
  authorization findings above remain open. No release or cutover occurred.

### Transactional source identity and updated staging access

- Both local PA directory endpoints now require the expected installation UUID
  in `X-PA-Source-Instance-ID`. The command service runs the precondition after
  authorization and before receipt lookup, using the existing identity/sequence
  row lock. This prevents a wrong-instance request from mutating profiles or
  returning a cached successful result. Success carries the checked identity.
  Both endpoints advertise `requiresSourceInstanceId: true`; Ops requires that
  declaration before POST and validates the response identity afterward.
- Independent Terra review found no blocking issue in this placement or its
  policy/sequence lock order. Parent focused PA tests passed **59 tests, 488
  assertions**. The real front-controller/disposable MySQL rehearsal passed
  **5 tests, 129 assertions**, including both resource families and denial
  readback. A subsequent metadata assertion addition is covered by the next
  rehearsal, not implied by that earlier count.
- The longer HTTP rehearsal exposed Windows development-server output pipe
  backpressure. The first run failed and a pipe-draining attempt stalled. The
  exact stalled run was stopped and its label-verified disposable container
  removed. Test server output now goes directly to the platform null device;
  production logging is unchanged. The successful rehearsal above used this fix.
- The owner accepted staging Terms. Browser inspection confirmed a signed-in,
  empty staging dashboard and visible revision `59e8644`. Its API-key form still
  exposes the legacy full-access option rather than this local scoped candidate.
  No key, customer, invoice, integration, or other staging data was created.
- Read the updated `Downloads/tmp/pa-staging-access.md` handoff. A read-only
  check of the documented HTTPS control `/status` returned **401 without the
  token and 200 with it**. This supersedes the earlier unauthenticated-control
  observation. Cloudflare Access remains pending according to the handoff, not
  independently verified. Credentials are omitted from all migration artifacts.
  No restart, rebuild, inspection dump, production action, or publication occurred.
- Final parent verification for this increment: PA full suite **1,017 tests,
  7,521 assertions, 94 skipped**, exit 0; final real disposable MySQL/HTTP
  rehearsal **5 tests, 131 assertions**, zero skips/failures; final Ops readiness
  and command-consumer suites **78 tests passed**, and TypeScript check exit 0.
  All referenced processes are terminal. These supersede the narrower earlier
  counts, not the remaining migration/production acceptance gates. No live
  connection, ownership policy, public link, retention setting or token changed.

### Staging Access inspection and attachment-boundary candidate

- The supplied `Downloads/prompt.md` management-token candidate returned HTTP
  401 from Cloudflare's token verification endpoint, including a recheck that
  ignored blank lines. Its validity and administrative scopes are not proved;
  do not confuse it with the separately working staging-control bearer token.
- After owner authorization to use the signed-in browser, inspected all nine
  Access applications. Neither staging hostname is configured there. The
  existing Ops Sync policy uses Service Auth with specifically named service
  tokens. No production policy was edited. Requested approval for a separate
  staging-control application and independent Codex/Hermes credentials, retaining
  the origin bearer authentication. Creation and acceptance tests remain pending.
- Local PA candidate now gates organization document reads on a current exact
  attachment pointer, current active session identity, and existing organization
  permissions. Upload path resolution rejects child aliases that could cross
  the public-logo/private-document boundary. Public branding and unrelated
  authenticated upload categories must remain functional. Syntax checks pass;
  focused regressions, independent candidate review, and complete verification
  remain pending. This is not yet a verified fix or deployed change.

### Revised LAN-only staging handoff

- The owner supplied another access-guide revision: staging app now uses
  `http://192.168.60.92:1628`, control API `http://192.168.60.92:8201`.
  The guide states public tunnels were removed. This supersedes the proposed
  staging Cloudflare Access setup; no Access application or token was created.
- Read-only app request returned HTTP 200, and the in-app browser rendered its
  login form. No login credentials were transmitted in this check. Control
  `/health` and unauthenticated `/status` each timed out after ten seconds, so
  control reachability/authenticated operation remain unverified. The old public
  URLs also timed out; this alone is not proof that every public route was removed.
- LAN HTTP provides no transport encryption. Prefer HTTPS or a trusted encrypted
  administrative path for login/control credentials; LAN placement alone does
  not establish confidentiality. No restart/rebuild/control mutation occurred.
- Attachment candidate independent review identified Linux legacy filenames
  ending in dot/space being newly rejected. Narrowed that alias guard to Windows;
  exact Linux paths remain supported. Regression extension and final full-suite
  verification are still in progress, not claimed complete.

- After the owner reported the UFW fix, fresh LAN checks returned `/health`
  HTTP 200, `/status` without a bearer HTTP 401, and authenticated `/status`
  HTTP 200 with four container records. This resolves the observed control-port
  reachability blocker. No container health claim, restart, rebuild, or other
  mutation follows from this status-only check. The LAN HTTP encryption caveat
  remains unchanged.

### Attachment verification complete locally

- Final focused Linux verification passed **16 tests, 93 assertions, zero skips**.
  The parent full PA suite completed with **1,033 tests, 7,599 assertions, 96
  skips**, exit 0. The two added platform skips are exercised by the Linux run;
  the 94 pre-existing skips remain outside this evidence.
- The scoped attachment fix and its single independent candidate review are
  complete locally. Actual controller file-response tests cover denial of physical
  orphan/removed files and preservation of public logos, current authorized
  attachments, other authenticated uploads and Linux legacy names. Full details
  are in [attachment verification](organization-attachment-fix-verification.md).
  Nothing was published or deployed. Joined directory consumer/producer testing
  is the next active gate; the durable Ops outbox and authority cutover remain open.

### Joined directory API gate verified locally

- Added an explicitly enabled joined Ops Vitest test and PA harness wiring. It
  calls the actual Ops consumer through pinned loopback HTTPS into PA's actual
  generic HTTP handlers and isolated MySQL. No production transport/authentication
  relaxation is part of the test.
- Parent review corrected two test defects before the run: response loss must
  discard the entire upstream response before disconnecting, and SQL must resolve
  external IDs through bindings rather than confuse them with PA public IDs.
- Parent joined execution passed **6 tests, 144 assertions**, zero skips, exit 0;
  this includes the five existing real HTTP cases and the new joined case. SQL
  proves one organization and one linked client after replay, four receipts, five
  successful attempts and one stale-revision conflict audit. The ordinary Ops
  selection passed **78 tests**, with the opt-in joined case skipped by default.
  Label-filtered container inspection after cleanup was empty.
- See [interface foundation](api-first-interface-foundation.md#joined-directory-consumerproducer-rehearsal)
  for execution and proof boundaries. The next implementation gate is durable
  Ops command persistence/recovery and canonical directory wiring; neither live
  PA instance nor production Operations has been switched to the new authority.

### Durable Ops commands and application identity: active increment

- Revalidated the goal and current worktrees. Ops `OPS_DB` owns the forthcoming
  directory outbox; `DELIVERY_DB` is not the directory authority store. Source
  inspection confirmed the existing PA customer tables are projections and
  business-party links are presentation grouping, not canonical shared profiles.
- Expanded [directory ownership constraints](directory-authority-migration.md#ops-durable-ownership-boundary-implementation-constraints)
  to specify atomic local revision/audit/destination intents, ordered command
  materialization, independent per-instance delivery, mapping retention and
  preservation of existing routes/public links. Queue completion alone will not
  satisfy canonical customer ownership or coordinated cutover.
- Found an additional retry-identity gap: the same PA instance can authenticate
  credentials from different applications, while receipts are application-scoped.
  The local Ops transport now requires the expected application UUID, checks it
  in capabilities, requires advertised application precondition enforcement,
  sends it on each command and checks it in successful receipts. A rotated token
  from the same application remains valid; a different application fails closed.
- Parent transport verification passed **90 tests** after adding this fence,
  including missing/wrong application identity, preflight mutation, missing
  advertised enforcement, wrong/absent receipt identity and same-app rotation.
  This is consumer-unit evidence, not proof of producer enforcement. Matching PA
  changes and the joined real HTTP/MySQL rerun remain in progress.
- The Sol outbox implementation is local and under review. Parent review raised
  dispatch source selection, acknowledgment of subsequent updates, immutable
  command validation, application-qualified mappings, durable conflict reporting
  and stale-lease outcomes. These must be corrected and tested before wiring
  production dispatch. No new migration has been applied remotely.

- Follow-up verification: parent combined Ops transport/outbox selection passed
  **101 tests**, exit 0; parent TypeScript check passed. Real Miniflare D1 tests
  now cover competing claims, stale-worker settlement, a trigger-induced local
  acknowledgment failure rolling back the mapping, same-ID recovery, create then
  update using one retained mapping, and isolation from another source's queue.
  A failed local receipt save leaves the durable command recoverable; it is not
  treated as a successful local acknowledgment.
- The initial updated PA HTTP rehearsal failed with `APPLICATION_ID_REQUIRED`:
  `public/index.php` omitted the new header when building the dispatcher request.
  The corrected front-controller adapter and expanded tests passed the joined
  disposable HTTP/MySQL run (**7 tests, 173 assertions**, agent execution).
  Parent review requested an additional explicit wrong-application-token replay
  case against a pre-existing receipt; that extension is still being verified.
- Remaining before release: canonical Ops revision/audit/intent transaction and
  route authorization, dependency-aware per-resource ordering, read/change-feed
  reconciliation, deployed per-instance configuration, and owner-reviewed PA
  deployment. The queue migration and modules remain local/unwired; the original
  public links, Incoming retention and production connections remain unchanged.

- The next joined run passed **7 tests, 181 assertions**, including a different
  application's credential being rejected before replay and a rotated same-app
  credential retaining the original receipt. Parent requested that the negative
  replay fixture also grant the second application equivalent resource authority,
  ensuring the expected denial is the identity fence, not an unrelated grant
  failure. The strengthened fixture's final joined rerun also passed **7 tests,
  181 assertions**. This completes this local application-fence rehearsal only.
- Started the complete PA regression suite after the front-controller change.
  It is still running at this checkpoint; the earlier full-suite count predates
  this increment and must not be used as proof that the latest tree passes.

### Canonical customer transaction increment

- The parent full PA run is now terminal, exit 0: **1,034 tests, 7,619 assertions,
  96 skips**, elapsed 3:54.105. The separately enabled joined HTTP/MySQL gate
  remains **7 tests / 181 assertions**. The skipped ordinary-suite cases are not
  counted as exercised; neither run establishes production deployment.
- Started local canonical Ops record/revision/audit/intent persistence. This is
  the missing transaction preceding remote command materialization, not a rename
  of the imported PA projections. A saved profile must remain available when no
  PA destination is reachable or selected.
- Source review found existing team/presentation-link and invitation-review
  permissions cannot be reused as canonical customer editing authority. The
  [route authorization checklist](directory-authority-migration.md#canonical-directory-route-authorization-integration-checklist)
  records separate capabilities, applicable scope/deny rules and same-transaction
  revocation checks. Do not expose the new persistence helper as an authenticated
  route before those checks and server-derived destination links are implemented.
- Initial persistence review requires immutable input snapshots before awaits,
  primary-session reads, transaction-local predecessor selection, idempotent
  concurrent replay, strict source/application identity and safe revision bounds.
  The canonical helper is now implemented locally; expanded parent tests and
  downstream materialization are tracked below.

### Canonical transaction review and compatibility checkpoint

- The Sol canonical-store implementation passed its focused 10-test Miniflare
  run. Parent combined API/transport/outbox/store verification then passed
  **111 tests across four files**; parent TypeScript check also passed. Two
  additional parent snapshot/concurrent-update cases subsequently passed with
  the store selection at **12 tests**. Further destination/schema checks are
  being verified; these historical counts do not include that later expansion.
- Independent Terra review identified ambiguity between destination validation
  and predecessor identity. The chosen contract is one remote customer per
  canonical record and source/instance/application. Parent retained duplicate
  destination rejection and added a database fence against origin/external-ID
  changes across edits. Ordinary edits cannot restart a customer sync stream.
- Parent tightened the unreleased 0054 outbox schema: command IDs cannot be null,
  and command, provenance and optional outcome columns must contain valid JSON.
  New real-D1 tests exercise direct invalid inserts/updates, rather than relying
  only on TypeScript callers to preserve these storage invariants.
- Luna independently ran six current-tree Operations compatibility suites:
  `public-share-routes`, `public-share-lifecycle`, `public-locations`,
  `single-file-share`, `single-file-share-migration`, and `bulk-download-client`.
  **44 tests passed**, no live requests or deployment. This is not the historical
  129-test client baseline, nor proof of all password/range/resume behavior or
  deployed public-link continuity. Those broader acceptance gates remain open.
- A Sol task is implementing the atomic intent-to-wire-reservation boundary.
  It must distinguish explicit remote creation from an existing identity,
  wait for predecessor acknowledgments, preserve exact retry bytes and reject
  unsupported field mappings without truncation. No route or scheduler is
  enabled by this work. Native authorization, canonical backfill/read paths,
  enrollment, complete PA writer guards and coordinated cutover remain required.

- Final parent foundation selection after the added concurrency, destination and
  schema regressions passed **116 tests across four files**, exit 0: API probe,
  directory transport, durable outbox and canonical store. This excludes the
  new materializer, whose separate initial six tests are insufficient for release.
- Parent materializer review found a recovery gap: an edit saved after its
  predecessor had already been acknowledged could remain waiting indefinitely.
  Idempotent reconciliation must ready these later successors too. Requested
  corrections also cover immutable input/proof snapshots, exact destination-bound
  proof, receipt/mapping consistency and a complete dispatch-based next-update
  test. The new 0056/module remain local and unwired during this review.

### September 11: receipt validation and native login boundary

- Parent exposed a shared stored-acknowledgment validator using the same complete
  success contract as live transport: source/application/resource identity,
  bounded decimal revision, public ID, response shape and status/replay rules.
  The materializer must additionally verify its durable outbox state and exact
  mapping; a syntactically valid acknowledgment is not synchronization authority.
- Parent also rejected array-to-string coercion of command UUIDs. The combined
  foundation plus staff-binding test selection passed **126 tests across five
  files**. This run excludes the still-reviewed materializer and is not a
  deployed-system acceptance claim.
- Sol implemented atomic staff binding in `auth.ts`: only an active exact-email
  row with an unbound or identical Access subject can return a principal, and
  returned fields come from `UPDATE ... RETURNING`. Eight local tests cover
  helper concurrency and the login adapter with the JWT verification boundary
  mocked. Existing bound logins preserve profile update time and refresh only
  last-seen time; initial binding still records a profile update.
- Terra's inventory confirmed that `provisioning_source='local'` alone does not
  protect staff from PA adoption/status/role synchronization; `sync_protected`
  is the current fence. Native admission/transfer and resource/business-area
  authority still need explicit implementation and migration. The login fix
  does not claim to complete independent staff ownership or directory editing.
- The first materializer correction was explicitly rejected as incomplete:
  partial/minified refactor, type error, missing database race fences and weak
  tests. Terra is completing the state/SQL corrections while Sol owns expanded
  dispatcher-based tests. No production release or authority switch occurred.

- The corrected materializer's parent local selection passed **22 tests**
  (14 materializer and eight staff-binding tests). It now exercises actual
  dispatcher/transport code with synthetic PA responses and real D1 receipts,
  including a late successor after prior reconciliation, immutable same-ID
  retries and a trigger-induced predecessor-revision race rolled back by SQL.
  A missing JSON disposition is rejected by the database, not only the helper.
  Parent subsequently tightened the final reconciliation return check to require
  the same current outbox acknowledgment. Final combined rerun remains pending.
- Parent's explicit Operations TypeScript run caught test fixture row types
  using `Record<string,string>` with unchecked indexing. The materializer
  dispatch fixture now declares the five actual required SQL columns. Earlier
  agent typecheck reports are not accepted as proof of the corrected full tree;
  rerun with the repository's exact Operations tsconfig before handoff.
- Parent reran the exact Operations `typescript/lib/tsc.js --noEmit` command
  after correcting those row types: exit 0. The new target-precondition change
  still needs its own final combined and paired-PA verification.

### Exact PA update target: newly confirmed release blocker

- Consumer-side `expectedProjectAlphaPublicId` was checked on responses but was
  absent from the request sent to PA. Producer command input accepts external ID
  and expected revision; both generic directory update services resolve the
  app-scoped external binding without checking an independently expected target.
- Immutable external bindings prevent later remapping, but do not prove that an
  initial Ops import/link proof names the intended record. A wrong initial
  binding to another authorized PA record with a coincident revision could be
  mutated before Ops rejected the response. Post-response validation is too late.
- Required fix in progress: a generic update-only `expectedPublicId` wire field,
  validated and included in durable command identity, checked in PA's mutation
  transaction before writes. Create omits it. Ops retains its descriptive local
  field and serializes it to that generic API name. Directory capabilities must
  advertise `requiresUpdatePublicId: true`; old producers fail readiness rather
  than receiving unsafe updates. Test both clients and organizations, successful
  retry and coincident-revision wrong-target rollback.
- This is a local paired-contract change, not permission to deploy one side or
  retire the legacy integration. PA publication still requires owner review;
  full generic writer coverage, native authority and cutover acceptance remain.

### September 11 paired target-precondition verification

- Both local implementations now enforce the generic `expectedPublicId` update
  precondition. PA checks the resolved binding during transaction authorization,
  before receipt replay or mutation, and includes it in the command digest.
  Ops requires `requiresUpdatePublicId: true` before sending commands and keeps
  the exact target in durable retry payloads. Creates omit the field.
- Independent read-only review found no substantive gap in this paired contract.
- Parent reran six Operations suites: **144 tests passed**, covering capabilities,
  transport, durable outbox, canonical store, materializer and staff identity
  binding. Exact Operations TypeScript `--noEmit` check exited 0.
- First joined real HTTP/MySQL run failed one managed-owner activation fixture:
  its update omitted the newly mandatory target. The fixture now carries the
  public ID returned by its own create response, without relaxing the API.
  Parent rerun passed **7 tests / 181 assertions**, including the joined Ops
  consumer, using the isolated disposable database/container harness.
- Full PA regression rerun is pending. None of these local results proves live
  acceptance or authorizes a one-sided deployment. PA remains unpublished.
- Next authority slice needs independent native grants and transactional
  revocation checks. Do not directly reuse PA-projected staff role assignments
  as canonical directory authority: PA reconciliation still owns those rows.
  A proposed grant/fence schema remains a design input, not implemented access.

### Native permission evaluator: local checkpoint

- Added `native-directory-permissions.ts` and focused tests. It evaluates only
  explicitly native-admitted active identities with matching bound Access
  subjects, complete resource context and native grants. PA roles are not an
  input. Five separate directory actions and global/business-area/division/
  assigned/resource scopes are supported, including dual-business customers.
- Any applicable deny wins across the common record's memberships. Parent
  review caught scope-value coercion and shared mutable denial-result arrays;
  the implementation now rejects malformed scope values and creates independent
  results. Duplicate grant IDs and sparse arrays are rejected as well.
- Parent focused run: **19 tests passed**. Exact Operations TypeScript check
  exited 0. Independent review additionally checked scope and permission
  separation. This is a pure policy module, not a deployed feature or a database
  write fence. Trusted native identity/grant loading, atomic authorization,
  account ownership migration and routes remain required.
- Full PA regression evidence remains pending: the captured run started at
  00:16:57 September 11, process 5104, and was verified live by the parent after
  contradictory wrapper reports. Captured output now contains PHPUnit startup
  and expected negative-test diagnostics, but no final verdict. Do not restart
  based on missing wrapper output; inspect that process and its existing logs.

### Conclusive PA regression and database authorization follow-up

- The earlier captured process ended and its wrapper removed the output without
  preserving a verdict. Parent confirmed it was absent before starting a direct
  terminal run. That run (session 74607) completed with **exit 0: 1,038 tests,
  7,639 assertions, 96 skipped**, in 3:54.002. Skipped environment/optional tests
  are not acceptance evidence. This supersedes the pending full-suite status
  above, but does not authorize PA publication or production cutover.
- Parent expanded native policy coverage to **22 passing tests**, adding
  view/edit separation, rejection of PA-shaped authority hints and incomplete
  context, exact subject matching and independently allocated result summaries.
- Local migration 0057 and a trusted database snapshot reader are being built.
  Parent's first real D1 run failed nine reader cases with `too many terms in
  compound SELECT`; the six-part UNION is not usable in this runtime. Replace it
  with bounded prepared reads in one primary-session batch, preserving a single
  atomic snapshot and every authority/deny check. Do not count the reader as
  verified until the real D1 rerun passes.
- The reader now uses six bounded prepared reads in one primary-session batch.
  It requires an existing canonical record, fixes validated input before I/O,
  and rejects oversized result sets before filtering active memberships/grants.
  Thus a truncated snapshot cannot silently omit a deny. SQL identity NULL and
  scope-shape constraints are exercised as well.
- Parent corrected-reader rerun (session 31958): **2 files / 36 tests passed**
  (22 pure policy plus 14 real-D1 cases); exact Operations TypeScript check
  (session 40113) exited 0. Migration 0057 is local and creates no admissions or
  privileges automatically. No routes use this reader yet. Full migration-chain
  rehearsal, audited grant administration, transactional canonical write fencing,
  staff ownership cutover and production acceptance remain open.

### Full migration rehearsal and write-fence work in progress

- Added an isolated rehearsal that applies the actual sorted Operations SQL
  migrations 0001 through 0057 without rewriting statements. Parent execution
  (session 17427) passed **1 test**, confirming seeded owner identity/role
  preservation, directory table availability and empty native admission/grant
  tables. This does not cover 0058 or a production-shaped data restore.
- Migration 0058 and the authenticated canonical-store signature are under
  construction. The required contract is
  `saveOperationsDirectoryMutation(db, mutation, authority)`; authority contains
  verified staff identity/Access subject and a server-issued create-admission ID
  for creation only. Approved scope context is many-to-many, not a single area.
  Exact destination enrollment must survive ordinary profile edits unchanged.
- Existing store and materializer fixtures are being adapted while preserving
  their original concurrency, snapshot, rollback and receipt tests. Their older
  passing totals do not verify the new signature or migration.
- Parent review of the first SQL draft identified a PA-status dependency,
  missing current create grant, post-CAS/live-fence phase mismatches, JSON field
  and missing-key checks, and admission revocation requirements. These are
  active implementation corrections, not accepted release behavior. Do not
  apply 0058 or expose new writes until corrected and independently exercised.
- Parent retained-store execution (session 45290) ended with all 14 cases
  failing during migration setup (`D1_ERROR: incomplete input`), before any
  mutation assertions ran. The materializer reviewer independently observed
  the same setup failure. SQL parsing must be corrected before these tests can
  provide authorization evidence.
- The chain rehearsal now includes 0058 and asserts that create admissions,
  enrollments and transient write fences also begin empty. This expanded test
  has not passed yet; the earlier 0057-only result remains the proven boundary.
- The local dependency layout changed: normal TypeScript/Vitest package paths
  are absent and an untracked `pnpm-lock.yaml` is present. Running the displaced
  TypeScript executable under `.ignored` fails with missing `@types/node` and
  `vite/client` definitions. This is not a successful typecheck or evidence of
  application type errors. Preserve concurrent dependency work and restore a
  coherent, lockfile-backed test environment before reporting new QA results.
- Subsequent parent syntax check used Node's built-in SQLite with an isolated
  in-memory database and executed every actual migration from 0001 through
  0058, without statement rewriting: **exit 0**. The current SQL therefore
  parses/applies in SQLite. D1/Wrangler-parser execution and behavioral tests
  remain unverified after the concurrent dependency-layout change.
- Added a retained-store regression for 16 destinations: an authorized replay
  must return exactly the original intent ordering, including indexes 10–15.
  Source review also identified an identical-create retry window between the
  initial receipt lookup and consumption of its create admission; the store
  owner is addressing that window without relaxing fresh authorization.
- The store now attempts a fresh-authorized exact replay when another writer
  consumes the create admission after the initial receipt lookup, and orders
  replay intents by their numeric index. Parent added a deterministic database
  wrapper test that commits the winning write at that exact boundary, plus the
  16-destination ordering regression (16 retained store cases total).
- Syntax-only TypeScript transpilation of the store and its three focused test
  files completed with zero syntax errors. This uses the available displaced
  compiler without changing dependencies; it is explicitly **not** a typecheck
  or behavioral pass. All new D1 regression results remain pending.
- Parent aligned the authorization snapshot reader with write/replay policy:
  an active resource membership whose area or division is disabled causes a
  denied snapshot, rather than silently dropping that policy context. Added
  two reader regression cases (disabled area and disabled division).
- A dependency-free smoke executed the actual transpiled reader and policy
  against a transactional in-memory SQLite adapter, with actual migrations
  0001/0055/0057 and synthetic data: global allow succeeded while the area was
  active and denied after area deactivation (exit 0). This is focused adapter
  evidence only, not D1 execution, full typechecking or production acceptance.
- Parent then executed the actual transpiled canonical store, reader and policy
  against a transactional in-memory SQLite adapter after applying every actual
  migration through 0058. Five focused checks passed: authorized creation,
  exact replay with 16 ordered destinations, authorized update, rollback of a
  forced audit failure (version unchanged and no surviving write fence), and
  rejection of replay after grant revocation. Only synthetic data was used.
  This validates those SQL/store interactions in SQLite, not D1 concurrency,
  runtime packaging, full TypeScript typing or the deferred focused suites.
- The owner authorized npm-lockfile restoration. `npm ci --no-audit --no-fund`
  in `apps/operations` failed with Windows EPERM while unlinking the local
  `@cloudflare/workerd-windows-64/bin/workerd.exe`; installation is incomplete
  and may have removed other generated dependencies before failing. Do not
  assume the earlier `.ignored` fallback tooling remains available.
- Read-only process inspection identified local workerd PID 3344 beneath
  Miniflare Node PID 63628, with the executable in this exact worktree. Both
  remained live on recheck. Approval was requested to stop only these processes
  before retrying; no process was terminated, no pnpm file removed, and no
  production configuration changed. Revalidate process identity before any
  approved termination to avoid acting on a reused PID.
- Owner subsequently authorized the scoped repair. Revalidated both local
  process identities; PowerShell Stop-Process failed, so Windows CIM termination
  was used and their exit was confirmed. npm CI then restored Operations (401
  packages) and client (173 packages, required by the shared migration helper).
  Both package-lock SHA-256 hashes match their pre-repair values; the unexpected
  pnpm lockfile remains untouched. No production process or deployment changed.
- Restored Operations `tsc --noEmit` completed with exit 0 (session 71041).
  The focused six-file D1 run is in progress (session 50754). Early failures
  identified materializer fixture JSON canonicalization and two superseded
  store error-message expectations; corrections retain rejection/rollback
  assertions. Do not count corrected files as passing until a new run finishes.
- First restored six-file run completed: 66 passed / 16 failed out of 82
  (session 50754). All failures were in retained store/materializer fixtures:
  canonical approval JSON ordering, admission-vs-stale error expectations,
  and a duplicate-destination fixture that hit the admission SQL guard before
  reaching the store validator. The validator test now calls the store directly;
  no authority guard was weakened and all historical rollback checks remain.
- Corrected store/materializer rerun passed **30/30 tests, 2 files** (session
  79350). Together with the first run's four passing suites, all **82 cases
  across six focused suites** now pass: store 16, materializer 14, write authority
  13, migration chain 1, native reader 16, pure native policy 22. These are real
  Miniflare/D1 tests, superseding the earlier SQLite-only verification gap for
  this slice. Post-edit full Operations TypeScript check also exited 0 (88010).
  This is not whole-system or production acceptance; no release was performed.
- Adjacent PA directory API and durable-outbox regression run also passed
  **58/58 tests, 2 files** (session 99453). The verified repair total is therefore
  140 cases across eight focused files, plus the full Operations typecheck.
  The dependency/file-lock blocker is resolved. Keep the remaining migration,
  public-link compatibility, staging and owner-deployed PA acceptance gates.
- Expanded migration rehearsal now applies the complete chain with pre-0058
  canonical records, immutable revisions, audits and pending source-qualified
  intents. Two deliberately identical-looking customers remain distinct, every
  historical row is unchanged, no native enrollment/grants appear, and direct
  post-upgrade writes remain denied. Real D1 run passed **2/2 tests** (59433).
  This is populated synthetic preservation evidence, not a production backup
  restore or authorization/backfill completion.
- Smaller-agent wiring review confirmed no production admission issuer or
  canonical directory scheduler caller exists yet, and login still relies on
  PA-managed staff status. An authorized single-record profile reader is being
  implemented with atomic policy/data snapshots; the next wiring sequence is
  recorded in `directory-authority-migration.md`. No routes or deployment flags
  were enabled during this increment.
- Authorized canonical-profile reads are now implemented locally. The fixed
  view-permission service reads policy and current revision in one primary D1
  batch, discards denied data, bounds profile bytes in SQL, and validates exact
  output fields. Independent review caught and corrected the reusable helper's
  ability to request profile rows with a non-view permission before acceptance.
- Final native authorization/read regression run passed **26/26 tests across
  two files** (54.02 seconds, exit 0): the 16 existing authorization cases and
  10 new read cases, including helper permission enforcement, input snapshotting,
  malformed stored data and concurrent revocation/profile updates. The concurrent
  case checks the allowed observable serial outcomes, not exhaustive scheduling.
  Independent full Operations TypeScript check passed (24826). No production
  routes, credentials, migrations or deployment settings changed in this slice.
- Next native-staff increment: inspected the legacy login, ACL loader, snapshot
  reconciler and separate Ops Sync webhook writer. Login-only replacement would
  leave PA roles and direct identity/status SQL authoritative. The full consumer
  checklist and chosen profile/admission ownership are recorded in
  `native-staff-authority.md`; no production switch is being made.
- Local 0059/native identity resolver implementation is under review. Native
  admissions remain the sole active/subject authority; the dependent profile
  owns only login email/display/revision. The resolver returns a distinct shape
  and never first-binds by email or falls back to legacy staff identity fields.
  Full-chain migration rehearsal now includes 0059. Test results follow after
  review corrections and terminal verification, not from source inspection alone.
- Native staff foundation verification is now complete locally: **65/65 tests
  across five suites**, terminal session 66954, exit 0, 101.30 seconds. Coverage
  includes native identity, real full migration chain through 0059, directory
  permission evaluation, atomic authorization snapshots and canonical reads.
  Independent full Operations TypeScript check also passed (75597).
- Review corrected the email-normalization CHECK to use binary comparison,
  bounded raw display-name storage, and required safe integer profile revisions.
  The native login and directory layers now share exact opaque-subject validation;
  tests cover punctuation, mismatches, invalid bounds and revocation. Migration
  tests preserve existing records and create no native profiles or grants.
- This completes the local native identity storage/resolver foundation, not
  account bootstrap, grant administration, HTTP authentication activation or
  production acceptance. Both PA staff writers and the legacy ACL/direct-SQL
  consumers listed in `native-staff-authority.md` still require cutover work.
  Production configuration, public links and PA releases remain unchanged.
- Bootstrap preparation now has an explicit execution contract in
  `native-staff-bootstrap.md`: preserve reviewed permanent IDs, verify proposed
  subject bindings independently, never inherit PA roles, distinguish one-time
  bootstrap from routine delegated administration, and atomically recheck current
  state before any future execution. A review-only manifest planner is being
  implemented; it does not create native admissions or runtime authority.
- The review-only planner is now implemented and independently verified:
  **37/37 pure tests across two files** (10 planner cases and 27 permission cases),
  exit 0; full Operations TypeScript check passed (93773). Initial independent
  Vitest launch was denied an ancestor configuration-directory read; the same
  two synthetic suites passed under scoped elevation. No dependencies changed.
- Planner coverage includes exact existing bridge identity/protection snapshots,
  explicit new bridges, normalized and cross-field email collisions, opaque
  subject preservation, explicit allow/deny scopes, database-equivalent duplicate
  grants, array accessors/symbol iterators, size bounds and immutable output.
  Independent review found no remaining concrete planner defect. This is not
  evidence of executed staff migration: no populated manifest, admission, grant,
  deployment or runtime bootstrap authority was created.
- Atomic maintenance execution is now implemented locally in migration 0060 and
  `native-staff-bootstrap-execution.ts`. Durable out-of-band approval binds the
  exact operator, reviewed plan and per-person identity evidence. The executor
  rechecks database-time validity, bridge snapshots, collisions, all preexisting
  native grants and live scopes before one transactional write. Exact retries
  do not reactivate revoked admissions. There is no approval issuer or HTTP route.
- Verification: combined executor/full-chain rehearsal **11/11 tests passed**
  (session 50643, 56.13 seconds); final executor regression **9/9 passed**
  (25.29 seconds), including explicit subject collisions and the final revocation
  timestamp constraint. The initial run exposed an expiry error-classification
  mismatch and a test trigger setup problem; both were corrected before rerun.
  Independent Operations TypeScript check passed (13453), and the implementation
  agent's final typecheck passed. These are disposable local D1/Miniflare tests,
  not production database acceptance.
- Migration rehearsal extends through 0060 and checks that schema installation
  creates no approvals, receipts, profiles or grants. Execution is capped at
  16 entries, 128 grants and 256 KiB canonical plan JSON. Routine delegated staff
  administration, trusted maintenance approval installation, legacy authority
  fencing and live native authentication remain required before activation.
  No production changes, PA publishing or public-link changes were made.
- Native staff cutover follow-up is in progress: snapshot recovery and Ops Sync
  now carry permanent-ID admission guards on legacy staff writes. Revoked
  admissions remain protected; PA cache records remain separate. Independent
  review caught and corrected missing protected-owner guards on webhook ACL
  deletion and an unrelated-ID comparison in division insertion. Regression
  tests are still running; this is not yet a verified release checkpoint.
- Added the unwired native-only Access email query and a local D1 acceptance
  fixture. The current Cloudflare reconciler remains unchanged until coordinated
  native login activation. Operations and Ops Sync TypeScript checks passed;
  native entry-query database tests and full projection regressions remain to
  be recorded after terminal completion. See `native-staff-authority.md` for
  explicit routine-administration and release prerequisites.
- September 11 release-record reconciliation: fresh GitHub readback confirms
  PR48 merged as `63425fc9758bb37037eb14ba181eb8f586e21636` and PR49 as
  `80bc4e053449f69d5aa5dbf086a691455bc32916`; post-merge CI runs
  `34547269404` and `34548853779` are completed/success. This is fresh GitHub
  evidence, not a new Cloudflare runtime inspection. Corrected stale Incoming
  runbook/checklist language that still described publication as off and pickup
  as paused. Prior exact deployment readback and the owner's MP3 receipt remain
  the evidence for that rollout. The isolated five-file form commit `15fe0c1`
  still requires the previously requested exact source-export approval; that
  approval was requested again without attempting a bypass. Other goal work
  continues independently.
- Staff-fence test checkpoint: native Access eligibility **2 tests passed**.
  The real snapshot regression then passed **1 test, 20.38 seconds**, after
  correcting its fixture to use a separate Delivery database rather than the
  Operations schema. The production sync path was not weakened for the fixture.
  The first broad webhook run was interrupted without a result and is not
  evidence of a failure or pass. A focused five-case run hit the old 10-second
  beforeEach timeout while constructing the full migration chain; its assertions
  were not reached. The setup allowance is now 30 seconds and that exact focused
  regression is being rerun. Full webhook/snapshot regression acceptance remains
  outstanding; no native authority or login switch has been released.
- Focused webhook rerun completed: **5 tests passed, 20 unselected**, 81.51
  seconds (59386). This includes active/revoked admission fences and protected
  owner behavior with an explicitly established PA mapping. Full 25-test
  projection regression is running separately with verbose reporting (76044);
  keep polling that handle rather than restarting it for slow output.
- Readable Incoming naming release preparation is now isolated on local branch
  `codex/incoming-readable-folders`, worktree `Incoming-Readable-Folders`, from
  freshly fetched main `80bc4e053449f69d5aa5dbf086a691455bc32916`. Only the four
  naming source/test files and naming-only runbook hunk are being transplanted.
  Prior dirty-worktree test results are not exact-candidate evidence: isolated
  test/build review and any required export permission remain before release.
  No push, commit, merge, deployment, retention change or object rename occurred.
- Full Ops Sync projection regression completed: **25/25 tests passed**, one
  file, 435.43 seconds (76044). This verifies the local legacy-writer fences;
  it does not activate native authentication or replace production acceptance.
  Existing Operations snapshot regressions also passed **23/23 tests**, one
  file, 5.53 seconds. Both worker TypeScript checks and diff checks passed.
- Readable Incoming naming isolation is complete: exactly five intended files,
  clean diff whitespace checks, existing journal destinations preserved. Restored
  Operations and Client dependencies from their existing npm lockfiles with
  lifecycle scripts disabled. Initial isolated checks encountered missing Client
  cross-app dependencies and a sandbox esbuild ancestor-read restriction; checks
  are being rerun after dependency restoration with scoped build permission.
  No lockfile changes, source export, deployment or retention changes occurred.
- Exact isolated Incoming candidate passed TypeScript and build, plus **80/80
  tests across ten files** (22 naming/promotion and 58 read/workflow/retention/
  reconciliation/outbox/driver/dispatch/summary regressions). An earlier test
  invocation lost its terminal handle and had no surviving matching process;
  it was treated as unverified, then rerun to obtain the terminal 58-test result.
  Saved the five reviewed files as local commit `7cf8080` on
  `codex/incoming-readable-folders`; no existing object paths are rewritten.
- The next native administration slice is in implementation: explicit native
  administrative delegations and target memberships, versioned display-name
  edits/admission disablement and immutable transactional command receipts.
  Operational grants do not imply staff administration. Onboarding, verified
  identity recovery, grant management, route/UI wiring and coordinated native
  authentication remain required; this slice is not a complete cutover.
- Published only Incoming naming commit `7cf8080eaa7e1ddb592926375b631c0e608d6f67`
  after scoped export approval and opened
  [Ops PR50](https://github.com/ledgetoptechnologies/LedgeTop-Ops/pull/50).
  GitHub CI and merge/deployment acceptance remain outstanding. This is separate
  from the earlier upload-form commit/export gate; no PA release was performed.
- Native staff administration review found pre-release concurrency and stale
  command defects: last-admin protection was only a preflight, and a matching
  final version/value could incorrectly prove that a mutation happened. The
  implementation now fences the last-admin decision in SQL and consumes an
  exact mutation marker before admitting an audit receipt; regression execution
  is in progress, not yet acceptance. Root also extended the migration-chain
  suite through 0061 and added a populated revoked-admission upgrade test.
- Initial staff-management authority will require an explicit version-2
  reviewed bootstrap payload. Version-1 approvals retain directory-only meaning;
  they must not expand into administrative grants after an executor upgrade.
  The planner work is underway; atomic v2 execution and actual first-admin
  command acceptance remain required. No native login or production grants
  have been activated.
- Migration-chain verification through 0061 passed **3/3 tests**, including the
  populated revoked-admission upgrade. The first administration run passed
  **6/7** cases; its concurrent-disable assertion had an extra active global
  administrator left by a previous fixture. Root identified that test isolation
  error: it is not evidence of D1 session inconsistency. The fixture now asserts
  its exact two administrators before the race; corrected acceptance is pending.
- Version-2 bootstrap proposal validation passed **6/6 pure tests**, with the
  unchanged v1 planner passing **10/10** alongside it. Initial authority must be
  an explicitly reviewed existing bridge because approval rows already reference
  that bridge; native admission may be created in the atomic bootstrap. Atomic
  v2 executor integration and first-administrator command acceptance are now
  in implementation. No existing approval gains new permissions implicitly.
- Corrected native administration regression completed: **8/8 tests passed**,
  24.64 seconds (75090), including the exact two-global-admin concurrency
  fixture. The intervening stale-fixture run is superseded, not additional
  passing evidence. Extra audit-failure rollback, replay revocation and positive
  scoped-manager coverage are being added before treating this service as ready.
  PR50 CI currently has eight successful jobs with Operations tests and mobile
  Operations browser acceptance still running; no merge/deployment yet.
- Expanded native administration suite passed **10/10 tests**, 27.99 seconds
  (30631), including rollback of both mutation types when audit insertion fails,
  wrong-subject/revoked-delegation replay denial and positive division-scoped
  access versus unrelated-division denial. Initial v2 executor review identified
  missing v1 verification/directory-scope checks in the new path; those must be
  restored and regression-tested before bootstrap acceptance. The v1 planner's
  compatibility result alone does not prove executor parity.
- PR50 merged after all ten pre-merge CI jobs passed at head
  `7cf8080eaa7e1ddb592926375b631c0e608d6f67`; merge commit is
  `60c6af70d330e39e97f9e7742e56510f84895cb0`. The merge commit's Cloudflare
  Workers Builds checks succeeded for Operations, Ops Sync and Clients.
  Operations build `6a705157-a043-4d1f-9ddd-d3add814afca` completed, and
  deployment `12b6b79f-b7a9-4771-93a7-ef9d78d8704e` serves version
  `3548a141-968b-4c37-9605-185c4f6d9f58` at 100%, created
  `2026-09-11T13:44:50.287935Z`. Version annotations do not embed a commit;
  the commit-specific successful build check supplies release correlation.
  New upload publications use readable submitter folders; existing journals,
  public links and retention remain unchanged. A fresh user upload/pickup is
  still needed for end-to-end confirmation of the new folder appearance.
- V1 bootstrap plus native Access regression passed **11/11 tests**, 42.28
  seconds (53261). V2 first-admin manifests now require explicitly supplied
  global allows for both supported administrative actions and no authority deny
  at any scope, consistent with the service's last-administrator protection.
  This does not invent grants or broaden v1 approval. Expanded isolated v2
  executor failure/replay/rollback tests remain in progress; v2 is not yet
  release-ready and native production authority remains unchanged.
- Independent v2 review identified a synthetic success fixture mismatch between
  its seeded legacy email and the exact reviewed bridge email. The receipt
  precondition rejected it without writes, as intended; correct the fixture,
  not the live-state guard. Explicit string validation of execution IDs is also
  being added before regex checks to reject object coercion. Final expanded
  regression evidence must supersede the earlier partial/failing runs.
- V2 planner review found that global administrative allows could be placed in
  the authority entry but name a different cohort actor. Per-entry delegation
  ownership is now enforced and a displaced in-cohort actor case was added.
  Focused v2 planner/executor validation passed **11/11**, but that does not
  include all requested late-failure/replay/collision/aggregate-bound coverage.
  A combined run without terminal output remains unverified, not a pass.
- M05 source inspection confirms that `pa_projects` is still a PA projection
  and project-management routes are navigation targets, not two-origin writes.
  PA has reusable generic command/resource/binding/revision primitives but no
  generic project command adapter. The first local package is shared-project
  create/update composition, followed by same-transaction PA UI writer events,
  source-qualified Ops project identities/outbox and change-feed consumption.
  Existing PA project forms mix billing, recipients and public-link management;
  inbound shared-field sync must not reuse those forms wholesale or overwrite
  their financial/publication settings. No project route/cutover is activated
  by this local implementation work.
- PR50 post-merge CI run `34605905033` completed successfully: all ten jobs
  passed. This corroborates the already recorded Cloudflare deployment; the
  owner-side fresh readable-folder pickup and upload-email checks remain separate.
- Final bootstrap acceptance checkpoint: combined v1/v2 planner/executor run
  **35/35 passed**, 48.51 seconds, session 70630 exit 0. After strengthening
  the late-failure test to verify new bridge rollback and existing bridge
  preservation, the final v2 executor rerun passed **9/9**, 23.21 seconds.
  TypeScript and diff checks passed. This supersedes startup-only/partial runs;
  independent review found no remaining issue in the bounded source. Native
  production login, routine onboarding/delegation and the trusted maintenance
  approval installation procedure are still not enabled/completed.
- Parent independently ran native administration, v2 bootstrap execution and
  the complete Operations migration-chain suites together: **22/22 tests
  passed**, three files, 98.56 seconds, session 89454 exit 0. This checks the
  final local schema/service combination in addition to the planner regression.
- Initial PA shared-project command core exists locally (three new services,
  one focused test file; initial 4 tests/26 assertions), but parent review found
  create lifecycle values being ignored, null-date merge validation and lock-order
  issues, plus a placeholder transition authorizer. Repairs and wider transaction
  regression are required before accepting this core or wiring any HTTP route.
  The narrow initial pass is not API/release readiness.
- Remaining M04 work is organized in
  [native-staff-management-plan.md](native-staff-management-plan.md): isolated
  pending onboarding, exact capability/delegation limits, scoped inspection,
  atomic approval and separately approved identity recovery. This is a design
  with an acceptance matrix, not implemented routine employee management.
  Existing two-action bootstrap authority must not silently gain these powers.
- Parent added a dedicated exact `projects.write` scope regression. PA scope
  policy tests passed **7 tests / 65 assertions**: legacy aliases and even a
  legacy stored write string cannot acquire this capability; exact read or
  directory-write credentials do not imply it, and an explicit exact grant
  is required. This is scope-policy evidence, not project command acceptance.
- M05 follow-up boundaries: the current generic event primitive has ordered
  resource revisions but no command-origin/correlation metadata. Before wiring
  two-origin consumption, explicitly connect command receipts and source events,
  suppress import echoes, and test response-loss/event-arrival races. Do not
  describe the local command core alone as a two-way synchronizer. Independent
  review also identified an organization-owned client being accepted as a
  standalone customer; this must reject mismatched topology, while real
  standalone consumers remain supported. Archived-client mutation handling must
  not remove historical financial visibility.
- PA project-core follow-up: lifecycle/date/authorization repairs are in place;
  organization-owned clients cannot be submitted as standalone customers, while
  truly standalone clients remain supported. Shared mutation rejects an
  archived/deleted linked client without changing financial-history readers.
  Parent independently ran the project, close-guard, command, external-binding,
  directory and scope suites together: **61 tests / 387 assertions passed** on
  PHP 8.2.12. This is local SQLite/unit regression evidence only. Disposable
  MySQL validation is pending; HTTP wiring, PA UI writer events and two-origin
  Operations synchronization remain unfinished. No PA release is authorized by
  this checkpoint.
- Final bounded project-core checkpoint: invalid calendar dates now produce
  validation failure rather than a PHP false-return method-call error. The
  focused project/scope rerun passed **19 tests / 159 assertions**, independently
  repeated by parent after final formatting. The disposable MySQL runner passed
  **1 test / 40 assertions**, including all lifecycle values, revoked replay,
  revision conflicts, date clearing and late-audit rollback. Its generated
  name/ownership-label cleanup and post-cleanup absence checks completed. The
  fixture uses real MySQL and migrations 0090–0092 but only a partial domain
  schema: full-baseline rehearsal and the integration gaps above remain open.
- Parent broad PA Workflows run completed **857 tests / 6,457 assertions** with
  **one failure and 44 skips** (107.138 seconds). The failure is the static
  portal-writer inventory: it recognizes the two generic directory writers as
  independent revision/event producers but not the new generic project writer,
  and consequently expects legacy `source_version`/portal hooks. The inventory
  needs the exact new writer plus positive generic-contract assertions, not
  removal of legacy safeguards. Environment-dependent skips are not acceptance
  evidence. A corrected regression run is still required.
- The exact generic-project writer is now covered by that inventory with
  positive `shared_project`, revision, event, resource-authority and exact-write
  checks, plus absence of legacy producer activation. Legacy checks were not
  removed. Former failing method passed **1 test / 89 assertions** and its
  complete class passed **27 tests / 490 assertions**. Broad rerun pending.
- Final parent Workflows rerun completed successfully: **857 tests / 6,476
  assertions, 44 skipped, zero failures**, 106.463 seconds, session 19942 exit 0.
  This supersedes the prior inventory failure, not the skipped integration
  coverage. Production acceptance and the broader migration remain incomplete.
- Next M05 vertical slice implemented locally: generic
  `POST /api/v2/projects/commands` is routed before browser bootstrap and
  advertised only behind independent `APP_API_PROJECTS_ENABLED` plus the API
  master gate. It requires exact `projects.write`, source and application
  identities, transactional credential/resource checks, update public-ID
  matching, audited sanitized errors and authorized receipt replay. No gate or
  production connection was enabled. Parent combined PA dispatcher, directory,
  project, close-guard, portal-inventory and scope regression passed **89 tests /
  919 assertions** before the final supported-date-range refinement.
- Operations now has a separate bounded project transport and stored-response
  validator. It probes the exact project route without requiring directory write
  scopes; snapshots the command/destination before awaiting; sends no cookies,
  follows no redirects and does not expose provider error bodies. A timeout or
  lost/malformed response remains uncertain and requires replay of the same
  persisted command, never a newly invented command ID. Combined transport,
  directory and capabilities regressions passed **123 tests** before final date
  boundary cases. This does not yet provide durable project command reservation,
  a change-feed consumer, PA UI revision hooks, or coordinated production sync.
- Final Operations transport validation: **126 tests across three files passed**
  (new project transport plus existing directory and capabilities tests), and
  TypeScript passed. Project dates are restricted to valid calendar dates in
  `1000-01-01` through `9999-12-31`, aligned with the PA database-backed contract.
  No credentials, live requests, D1 writes, link settings or deployment changes
  were used for these synthetic transport checks.
- Authority distinction for subsequent reviews: optional externally managed
  **directory** mode does not make project names/status read-only; the owner
  explicitly requires project editing in either application. Generic project
  commands require their own resource authority and cannot edit customer
  profiles or reassign a project's customer through this bounded command.
  Do not accidentally apply the directory lock to the requested two-origin
  project workflow when composing PA UI writers.
- Parent final PA project dispatcher/core/scope rerun after date-boundary
  repair passed **28 tests / 198 assertions**. New dispatcher is readable and
  boundary tests cover method/query/media/encoding/size/JSON, missing or malformed
  identity headers, wrong update target, and revoked-key replay. The earlier
  broad Workflows pass predates this HTTP slice; it is not a claim that every
  new route has been exercised through a live web server.
- Joined project HTTP/MySQL checkpoint: the real Operations transport called the
  actual PA front controller through a certificate-pinned loopback TLS adapter
  and disposable MySQL. Corrected run **40911 exited 0: 2 PHP tests / 21
  assertions**, including the successful child Vitest joined test and independent
  SQL readback. A dropped committed create response replayed to exactly one
  project; rename/date clearing produced two receipts, three attempts and two
  events. Stale revision and incorrect update public ID produced the expected
  two audited 409 rejections. Source/application mismatch stopped at preflight.
  Private project publication stayed disabled. Separate real HTTP checks proved
  default-off before DB access, no session-cookie issuance and denied revoked-key
  replay. Initial run 38562 failed on a PHPUnit final-method/helper name collision;
  renaming the test helper corrected that harness issue, not application behavior.
  Runner cleanup and parent filtered Docker readback confirmed no test container
  remains. This uses migrations 0090–0093 over a partial domain fixture, not a
  full-baseline migration or completed two-way synchronization rehearsal.
- Remaining project integration is specified below in this work register:
  PA-local writer composition, canonical Ops project
  maps/outbox/inbox, generic reads/feed, conflict-aware consumption and UI.
- Atomic project event provenance implemented locally with migration 0095,
  typed mutation/receipt metadata, fresh-only in-transaction attribution, and
  history-preserving foreign keys. No-op/replay cannot claim an earlier event.
  Independent QA caught a nonlocking high-water read; corrected to acquire the
  singleton sequence lock and use a current MySQL locking read, including when
  the caller already established an older repeatable-read snapshot.
  Focused SQLite: **41 tests / 238 assertions**. Root disposable MySQL rerun
  **55139 exited 0: 2 tests / 46 assertions**, including two-connection stale
  attribution rejection. Root joined HTTP/MySQL rerun **40513 exited 0:
  2 tests / 44 assertions**, with exact receipt/application/source/project/version
  provenance readback after response loss and replay. Reviewed runners confirmed
  cleanup of their own disposable containers. No production authority change,
  PA publication, or full-baseline acceptance is implied.
- Broad post-provenance PA Workflows rerun **40967 exited 0** in 106.491 seconds:
  **869 tests / 6,545 assertions / 44 skipped**, no failures. Skipped tests are
  not acceptance evidence; the explicit disposable project MySQL and joined
  HTTP runners above passed without skips. PA-local project screen writers
  remain the next integration gap, not a completed feature.
- Additional real-MySQL provenance constraints passed: **2 tests / 52
  assertions**, terminal exit 0. The actual 0095 migration rejects deletion of
  a linked event and incomplete/mixed provenance shapes, retaining all four
  fixture events and their audit rows. No production data was accessed.
- Local-writer review identified two required concurrency boundaries: the broad
  PA edit form posts billing and shared fields together (stale finance edits
  cannot bypass shared-version checks), and existing session-role shortcuts /
  request-cached ACLs cannot by themselves establish current human authority
  for a tracked mutation. The bounded status-screen integration is in progress;
  create/edit/backfill/overdue normalization are still open.
- Independent local-writer review corrected a retention assumption: the guard
  protected API bindings but did not protect a locally observed, still-unbound
  `not_started` project. It now checks `shared_project` version state and event
  history under the project transaction, without filtering away tombstones.
  Focused retention suite passed **14 tests / 125 assertions**, including both
  state-only and event-only unbound histories. Existing unused legacy projects
  remain discardable; this adds no delete or tombstone workflow.
- PA tracked-project lifecycle screen slice is implemented locally: actual
  details forms/status controller, consistent displayed projection/revision,
  scalar identity/version tokens, current locked human role/permission/override
  checks, atomic local event provenance, and preserved closeout/schedule/portal
  behavior. Independent focused Workflows rerun passed **75 tests / 917
  assertions**, no skips. Real MySQL local/API interleaving is next; broad
  create/edit/backfill, legacy-overdue normalization, generic feed and Ops
  consumer remain incomplete. No PA release has occurred.
- Root real-MySQL lifecycle interleaving rerun **84372 exited 0: 4 tests / 95
  assertions**. Verified API create v1, local status v2, stale API conflict,
  current API rename v3 and exact ordered external/local/external provenance.
  Two-connection snapshot test confirms committed permission revocation is
  enforced, and disabled/deleted humans cannot mutate. Disposable cleanup passed.
  This tests real services/schema, not signed-in HTTP UI or full-baseline release.
- Broad post-local-status and retention rerun **71397 exited 0**, 106.481 seconds:
  **877 tests / 6,582 assertions / 44 skipped**, no failures. Skipped scenarios
  remain unverified by this run. The explicit MySQL interleaving suite above
  passed without skips; source was held stable during the broad run.
- PA broad edit handler now re-reads public-project token/password hash with the
  current locked billing-settings row, instead of overwriting them from the
  pre-transaction snapshot. Explicit new access codes remain intentional edits;
  required-code validation is repeated against current state. PHP lint and
  **34 project UI source tests / 690 assertions** pass. These source guards are
  not a concurrent signed-in HTTP acceptance test, which remains required.
- Bootstrap inspection confirms migration 0062 already establishes permanent
  generated project public IDs; preserve them exactly. No existing migration
  bootstraps `shared_project` versions. Legacy overdue, invalid names/dates,
  archived/mismatched customer links require an explicit reconciliation report,
  never silent rewrites of identity or recipients. Internal no-customer projects
  must keep working locally; the current API-create customer requirement differs
  from the nullable projection and needs deliberate contract handling before
  claiming full internal-project synchronization. Local create integration is
  underway; broad edit/versioning and bootstrap remain open.
- Local PA creation now uses a fresh public ID allocated before the controller's
  INSERT and verifies the exact inserted identity, creator, normalized shared
  fields and customer tuple before recording revision 1 and local provenance.
  Feature-off standalone creation remains unchanged; internal projects may
  retain null customer links. Implementer reports **70 tests / 897 assertions**
  and separate billing/contact regressions **20 / 184** passing. Root inspected
  the actual controller and context checks; real MySQL create coverage is being
  added before acceptance. No production mutation or release occurred.
- Independent combined project rerun found **100 tests / 1,077 assertions,
  one error** in the new edit provenance-failure fixture: the intended changed
  dates did not match the SQL mutation, so the projection guard correctly rejected
  the fixture before the injected provenance failure. Root also identified a
  separate edit lock-order defect (project/state acquired before authority and
  sequence). The edit slice is **not accepted** pending correction, current-user
  negative cases, lock-order regression coverage and a fresh focused rerun.
- Corrected edit slice independently rerun: **102 tests / 1,093 assertions,
  no failures** across local create/edit/lifecycle, generic project, retention
  and project UI suites. Authority and sequence locks now precede project/state
  locks; current disabled/deleted users are denied, stale forms disable Save,
  and server-side revision checks remain mandatory. Current public-link token
  and password rereads are preserved. Signed-in HTTP editing acceptance and
  full-baseline migration are still outstanding.
- Disposable MySQL run **79997 exited 0: 5 tests / 114 assertions**, no skips.
  Added local explicit-ID create, v1 provenance, no inferred binding, explicit
  application binding followed by generic update/replay, and complete rollback
  when local provenance insertion fails. Earlier run 7257 stopped because MySQL
  denied CREATE TRIGGER; no privileges or server settings were broadened.
  The revised synthetic fixture uses a scoped CHECK constraint instead. Exact
  disposable-container cleanup completed; production databases were untouched.
- Broad post-create/edit Workflows run **83598 exited 0**, 106.488 seconds:
  **900 tests / 6,671 assertions / 44 skipped**, no failures. Those skipped
  scenarios remain unverified by this run. Actual create/update controllers and
  edit view also pass PHP lint and whitespace checks. This checkpoint is local
  implementation evidence, not authorization to release PA or completion of M05.
- Follow-up root review corrected local-create gating to use the same
  `GenericProjectApiDispatcher::enabled()` decision as the API. Previously an
  unset `APP_API_ENABLED` defaulted differently, permitting API project writes
  while local creation remained untracked. Focused regression run passes
  **55 tests / 282 assertions**, including unset and explicit false/zero cases.
- Read/feed audit confirms no generic GET inventory/change-feed exists yet.
  Added implementation requirements to the project contract: new exact-only
  scope (not frozen legacy `projects.read`), explicit grant namespace mapping,
  authorization generation/resnapshot on grant changes, scanned-through cursor
  semantics and non-disclosing provenance. Read-only legacy-project readiness
  reporting is in progress; no bootstrap mutation or production scan occurred.
- Read-only `GenericProjectReadinessService` is now implemented with bounded
  internal-ID pagination and identifier/reason-code-only output. It flags invalid
  IDs, lifecycle/overdue, invalid or normalization-requiring names, date windows,
  missing/archived/deleted customers, relationship mismatches and inconsistent
  existing shared state. Internal no-customer projects are an explicit notice,
  not silently attached to a client. SQLite query-only mode verifies the report
  performs no database writes. Root combined project/local-writer rerun passes
  **62 tests / 304 assertions**. The report is advisory, not snapshot-consistent
  bootstrap authorization; every future mutation must revalidate under locks.
  It has not been run against production and does not perform migration itself.
- Added exact-only `projects.sync.read` capability without mapping or advertising
  a yet-unimplemented endpoint. Root scope-policy tests pass **8 / 82 assertions**
  and capability tests **7 / 42**: legacy full/read/project keys and write-only
  keys do not inherit it; it grants no financial/client read or project writes.
- Added internal resource-authority generation read from the existing immutable,
  application-scoped audit high-water. No new counter/schema or credential grants.
  Current application lock plus locking audit read protects against stale MySQL
  snapshots. Root authority/project/capabilities rerun passes **47 / 262**.
  Real two-connection MySQL coverage is pending. Restore/history replacement
  must invalidate cursors separately; the generation is not an access decision
  and does not alone establish a safe, deployed change feed.
- Real MySQL run **62243 exited 0: 6 tests / 120 assertions**, no skips,
  with exact disposable-container cleanup. The new two-connection test establishes
  an old repeatable-read snapshot, commits a grant through the normal authority
  writer, and proves the locking generation read sees that committed change.
  No-op and subsequent revoke checks also pass. Independent QA found no normal
  grant-write/cleanup bypass; full restore can still rewind audit/source history.
  Add the `(application_id,id)` audit lookup index when preparing feed migration,
  and implement restore/cursor invalidation before production feed acceptance.
- Added migration **0096** and baseline index `(application_id,id)` for the
  authorization-generation lookup. Real isolated MySQL run **67318 exited 0:
  7 tests / 122 assertions**, proving repeat application retains exact audit
  history and yields the intended index. Initial harness run56042 failed because
  its EXECUTE result set was not drained; the test now uses the production
  migration runner's query/closeCursor behavior. No production schema changed.
- Single-project generic GET reconciliation is in implementation and registered
  in early no-session routing, with exact-only read scope, source/app checks,
  current credential/resource/customer grants, and matching existing shared-state
  hash/revision. No state seeding or financial projection. Root and independent
  code review corrected exception mapping and checked route wiring; dedicated
  tests and real HTTP acceptance remain pending. Inventory/feed and Ops consumer
  are still separate unfinished work.
- Root current combined run after GET tests: **86 tests / 427 assertions**, no
  failures. Covers safe projection, source/app mismatch, credential revocation
  between initial authentication and transactional reread, linked customer grants,
  exact project grant isolation, internal/standalone customers, missing/stale
  shared state without observation, transport rejection and route/capabilities
  source wiring. The first incomplete fixture run used an unsuitable credential
  expiry and failed closed; corrected fixture now uses an explicit valid expiry.
  Real HTTP/MySQL GET, full-baseline and production acceptance remain unverified.
- Snapshot high-water fix: `beginSnapshot` now uses a current locking event read,
  not `MAX(sequence)` from a potentially old repeatable-read snapshot. Workflow
  Sync tests passed **13 / 159 assertions**; real MySQL run **50192 exited 0:
  8 tests / 124 assertions**, including a two-connection committed-event case.
  This corrects the watermark only; snapshot metadata still does not materialize
  an inventory. Do not claim point-in-time rows or a complete feed from this fix.
- September 12 real HTTP/MySQL run **98538 exited 0: 2 tests / 37 assertions**,
  no skips in the selected non-joined suite. Actual GET confirms no Set-Cookie or
  Location, no-store, exact safe projection and identity, unchanged project/public
  fields and sync/receipt/provenance records, customer-grant denial, missing/stale
  state without seeding, write-only scope denial and source mismatch. Disabled
  GET returns before database access. This is synthetic isolated acceptance only.
- Workspace permission changed to Ops-only writes. No further PA source writes
  have been attempted; prepared read-only source inspection and isolated test
  harness runs use the required approval path. Production remains untouched.
  Restore planning explicitly retains historical events/provenance and permanent
  source mappings; separate restore epoch/cursor invalidation is still required.
- Joined HTTP/MySQL run **58658 exited 0: 3 tests / 68 assertions**, including
  the existing actual Ops command transport rehearsal alongside the new GET
  tests. Disposable server/container cleanup completed. This checks that GET
  registration did not break the tested POST integration; it does not imply
  an Ops GET consumer, inventory, feed or production cutover is complete.

### September 12 — Ops single-project read transport checkpoint

- Added the isolated Ops GET client for the generic PA project endpoint; no D1
  persistence, UI wiring, production configuration or release changes in this slice.
- Requires the exact advertised read scope and source/application fences. Pins
  connection and project identity before awaiting preflight; reads bounded JSON
  without redirects or cookies and rejects extra financial fields, invalid IDs,
  mismatched correlation IDs, malformed lifecycle values and invalid revisions.
- Review corrected signed project-revision bounds independently of the unsigned
  authorization generation. Internal projects may retain null customer links;
  returned names are not silently normalized.
- Local focused GET/POST/capability suite passed **107 tests across 3 files**
  (terminal exit 0). The initial sandbox configuration-loader failure was followed
  by an approved local test run. Operations `tsc --noEmit` also exited 0.
- Still required: joined Ops GET-to-PA acceptance, inventory/change-feed and
  persistence wiring, independent QA, and coordinated production acceptance.
  This checkpoint does not establish live synchronization or complete the goal.

### September 12 — joined project read acceptance

- Extended the existing Ops/PA loopback HTTP/MySQL rehearsal to read the created
  project at revision 1, read the renamed project at revision 2, and repeat the
  read without changing its projection or authorization generation. Read results
  match the actual command results, not separate mocked fixtures.
- Incorrect source/application identities stop at preflight before a resource
  read. An unknown project returns reconciliation without a project payload.
  Exactly five original POST requests remain; SQL readback retains the expected
  project, receipt, event and provenance counts and disabled public visibility.
- Only the disposable joined fixture's synthetic API credential gained the
  explicit read capability. No existing or production credential was broadened.
- Joined runner **38838 exited 0: 3 PHP tests / 68 assertions**, with the nested
  Ops assertions required to pass and exact owned test-container cleanup verified
  by the harness. This supersedes the earlier POST-only joined checkpoint.
- Independent QA identified PHP/JavaScript Unicode whitespace differences; the
  reader now matches PHP's ASCII trim validation without modifying returned names.
  Focused transport regression rerun passed **110 tests / 3 files** (exit 0).
- Remaining: durable project mappings/outbox application, authorized inventory
  and change feed, restore-aware resynchronization, UI integration, and full
  coordinated production acceptance. No release or deployment occurred.

### September 12 — durable project outbox implementation in progress

- Draft migration `0062` adds destination reservation before network I/O,
  immutable outgoing-create mappings, durable commands and one unresolved command
  per project. Reverse mapping uniqueness is installation/public-ID based, not
  application/source-alias based. No production migration has been applied.
- Independent schema tests passed **4 tests / 1 file**, terminal exit 0, using
  isolated Miniflare/D1. They cover reverse uniqueness, invalid mapping links,
  immutable/no-delete history and pending/leased/terminal uniqueness.
- Dispatcher review requires pinned command/destination/origin inputs, current
  local-authority recheck, full-destination selection and unexpired lease/token
  settlement fences. Behavioral tests and final type checking are still pending;
  an initial type check found optional batch-result handling, subsequently edited
  but not yet accepted by a terminal rerun at this checkpoint.
- This outgoing-create mapping is not PA-origin adoption. Verified adoption of
  existing PA projects, event-before-response reconciliation, durable local drafts,
  live permission-provider/UI/scheduler wiring and production acceptance remain
  required. Never fabricate a create receipt for an imported project.
- Follow-up acceptance: combined queue/schema/project GET/POST/capability runner
  **60336 exited 0: 124 tests / 5 files**. Operations `tsc --noEmit` runner
  **71376 exited 0**. The earlier type-check issue is cleared. Initial behavior
  run 57261 had one timing-assumption failure (13 passed); the regression now
  reads the durable retry deadline, checks before-due idle, and dispatches exactly
  at due time. Retry scheduling production code was not relaxed for the test.
- Behavioral coverage includes concurrent claims, exact reservation snapshots,
  wrong mapping, credential rotation, malformed authority, stale success/failure
  after lease takeover, expired success without takeover, late-ack batch rollback,
  and full-destination selection without blocking another due project. These are
  isolated synthetic tests, not live authority-provider or production acceptance.

### September 12 — PA-origin project binding foundation

- Added the default-off generic PA `POST /api/v2/projects/bindings/commands`
  adapter, strict input, service and early front-controller route. The new exact
  `projects.bind` capability is not inherited from write/read or legacy tokens.
  Capability advertisement does not grant it to existing credentials.
- Binding requires current application/key/project/customer authority and a
  pre-observed matching shared revision. It creates only the explicit identity
  binding, audit and durable command receipt; it does not create/edit a project,
  publish sync events, grant access or expose anything to portal clients.
- Receipt replay rechecks current authority but can recover after a later PA
  edit. Its result contains only permanent IDs and the original linked revision;
  Operations must separately fetch the current authorized projection.
- Root acceptance: generic project/capability workflow suite **58 tests / 400
  assertions**, exit 0; exact scope suite **9 tests / 100 assertions**, exit 0.
  Front-controller and capability-dispatcher PHP lint passed. Initial HTTP unit
  failures were a missing `display_label` in the SQLite fixture and strict
  expectations not matching canonical receipt key ordering; only tests needed
  those corrections, not production error handling or authorization.
- Remaining: actual HTTP/MySQL binding acceptance, Ops binding transport and
  durable adoption provenance, inventory/feed and conflict/UI integration. This
  is not end-to-end PA-origin synchronization or production acceptance. No PA
  release, live migration, public-link change or production deployment occurred.
- Independent review found a duplicated `projects.bind` scope catalog entry;
  removed the duplicate and reran scope tests (9 / 100, exit 0). The existing
  `requiresUpdatePublicId` metadata is update-specific and is intentionally not
  copied onto binding: binding always requires `expectedPublicId` as documented
  in its separate strict command contract. Additional direct coverage of binding
  default-off, application mismatch and authentication-to-recheck revocation is
  still desirable before end-to-end acceptance.

### September 12 — binding HTTP/MySQL acceptance

- The actual PA front-controller binding endpoint now passes the isolated
  HTTP/MySQL harness: runner **65316 exited 0, 3 tests / 67 assertions** (includes
  existing project create/revoked-replay and GET cases). It verifies default-off
  handling before DB/bootstrap, application/source mismatch, exact scope denial,
  PA-origin observed-project binding, minimal fresh/replayed receipts, current
  GET after a simulated observed local edit, collisions, stale revision, current
  customer denial and revoked credentials. The fixture uses no API create receipt
  for its adopted project. Binding preserves checked domain/version/event/grant,
  provenance and public-link fields. The harness cleans up only its labelled
  disposable database container; no production database is used.
- Initial runner 59927 failed only the strict replay comparison because MySQL
  JSON storage reordered object keys. The test now recursively sorts object keys
  before strict value/type comparison; production serialization was not changed.
  The simulated local edit is transactional, but does not claim local-controller
  acceptance or local-provenance creation.
- Added direct dispatcher tests for default-off, wrong application, and revocation
  between initial authentication and the command recheck, for fresh and replayed
  requests. Focused dispatcher **7 / 55** and combined generic project/capability
  workflow **62 / 426** tests/assertions passed, terminal exit 0.
- Updated PA's generic API reference with the strict binding request, minimal
  receipt, revision semantics and non-grant guarantees. Remaining immediate work
  is the Ops binding transport and durable adoption provenance, followed by
  joined acceptance and inventory/change reconciliation. Neither production
  authority cutover nor PA release has occurred.

### September 12 — expanded project authorization regression checkpoint

- Added explicit create-replay denial when the original customer remains
  authorized but the current reassigned customer does not, plus malformed stored
  public-ID/customer rejection without recording successful replay attempts.
  Focused replay authority suite: **4 tests / 106 assertions passed**.
- Root full PA workflow runner **40558 exited 0**: **940 tests, 7,037 assertions,
  44 skipped**. Skipped tests are not acceptance evidence; this environment does
  not provide all optional database/runtime/fixture prerequisites. Separate
  isolated project HTTP/MySQL acceptance remains **4 / 85 passed**.
- PHP lint passed for the shared command executor, project command service and
  real HTTP integration test. Diff whitespace checks passed. PA remains local
  and unreleased; durable adoption and production verification are still open.

### September 12 — Ops project binding transport acceptance

- Added `project-alpha-project-binding-api-v2.ts` and focused transport tests.
  It preflights the exact binding endpoint and `projects.bind` capability, pins
  command/configuration before awaiting, and sends the four-field command without
  browser credentials or redirects. Access credentials stay in request headers,
  never in the command or returned diagnostics.
- The binding response must be the minimal HTTP 200 contract, with exact source,
  application, external/public IDs, original revision and request correlation.
  Extra project data, malformed envelopes, login/redirect/cookie responses,
  invalid UTF-8 and oversized responses are rejected as uncertain after dispatch.
  Responses are bounded to 64 KiB and the POST attempt has a ten-second abort.
  A retry reuses the caller's durable command; this helper does not create retries
  or persist mappings itself.
- Root combined binding/project GET/project POST/capabilities run passed **133
  tests / 4 files**, terminal exit 0. Root `tsc --noEmit` runner **60436 exited 0**.
  Review corrected an unsafe malformed-receipt property access and added exact
  identifier checks. Initial type check found only test-fixture nullable indexing,
  subsequently corrected without weakening production types.
- Read-only persistence QA confirms the existing create-only outbox cannot yet
  accept binding receipts. The contract document records the unified queue,
  explicit establishment provenance, pending authorized refresh and migration
  compatibility requirements. It also records internal-project null-customer
  update compatibility as a prerequisite. No deployment, database migration,
  public-link change or PA authority cutover occurred.

### September 12 — durable PA-origin adoption queue

- Added successor migration `0063_project_alpha_project_adoption.sql`; 0062 is
  unchanged. The successor copies all existing outbox fields and mapping history,
  preserves create-command references, and adds explicit create/bind establishment
  provenance. Binding never fabricates a create receipt. The migration must run
  transactionally with dispatch paused; no remote migration has been performed.
- The existing outbox now reserves and dispatches bind alongside create/update
  under one unresolved-command fence. Binding uses the strict separate transport,
  retains its original command/revision on retries, and atomically establishes
  mapping, pending refresh and acknowledgement under the current unexpired lease.
  A different source alias cannot reuse the same installation/project identity.
- A pending refresh prevents follow-up writes. It stores identity and the original
  minimum revision only, not project/customer data or client visibility. Independent
  QA prompted a schema trigger tying it to the exact leased binding and its stored
  expected revision, plus immutable refresh identity and deletion protection.
- Pre-trigger combined run **81711 passed 160 tests / 7 files**; type check
  **32660 exited 0**. Initial run 13055 failed only a history test comparing D1
  execution metadata; the corrected assertion compares every stored row field.
  Final trigger and full migration-chain validation is tracked in the follow-up
  checkpoint below, not inferred from the earlier test run.
- Remaining: current authorized refresh consumer and restore epochs, inventory/
  feed reconciliation, concrete staff-authority wiring, UI/scheduler and joined
  HTTP acceptance. The pending-only table is deliberately not a completed refresh
  state machine. Do not deploy this as finished project synchronization or release
  PA without the owner's review gate. Public links and retention are untouched.

Final adoption checkpoint: runner **78279 exited 0, 26 tests / 3 files passed**
after the refresh constraints were added. It covers the real 0001–0063 migration
chain, unchanged canonical customer history, 0062 acknowledged/pending/leased/
terminal preservation, injected whole-migration rollback, exact bind-revision
refresh constraints, immutable identity, queue/retry/lease races and atomic
mapping/refresh rollback on settlement failure. The max-revision test fixture
explicitly reserves the same max revision it expects in the marker. Final type
check **21682 exited 0**. These are local synthetic tests, not live deployment
or completed current-data refresh acceptance.

### September 12 — internal project updates and receipt authority

- PA and Ops now allow an existing internal project's update to omit customer or
  repeat its exact null/null customer. Generic create still requires a customer;
  customer reassignment and public visibility remain unchanged. Ops transport
  regression passed **134 tests / 4 files** and type check runner **43478 exited 0**.
- Review found missing current-customer authority checks on project updates and
  a historical-customer disclosure risk on stored receipt replay. PA now checks
  current customer grants before updates, and checks current mapped authority,
  strict stored identity/shape, and historical customer grants before returning
  create/update receipts. The shared command executor has an optional replay
  validator; other callers retain their existing behavior.
- Root reviewed the implementation and new tests. Broad generic project,
  directory, command and resource-authority workflows passed **148 tests / 897
  assertions**, exit 0. The isolated real HTTP/MySQL runner **29090** reported
  **4 tests / 85 assertions passed**, including internal project binding/update/
  replay with unchanged private visibility. No production data was involved.
- Remaining: durable Ops adoption, current authorized refresh, inventory/feed,
  reconciliation and live acceptance. These checks do not release PA or authorize
  a production cutover. Owner review/deployment remains the PA release gate.

### Joined binding and restore-history prerequisite checkpoint

- Root's disposable joined Ops/PHP/MySQL rehearsal (runner 98103) passed
  **6 tests / 138 assertions**. A lost binding response recovers the original
  receipt; a subsequent authorized read returns a later project revision.
  Existing grants and private visibility remain unchanged. This is local
  acceptance, not verification of deployed instances.
- PA source identity survives a database restore while revisions can rewind.
  Connector configuration versions and authorization generations do not solve
  that history ambiguity. Current authorized refresh therefore remains gated.
- An unreleased PA history-epoch service, empty migration 0097, explicit operator
  CLI and generic recovery documentation now provide the foundation. Rotation
  preserves source identity and retained history and commits its audit atomically.
  Initialization/rotation reject caller-active transactions; authoritative checks
  require the caller's transaction. Migration-file validation accepts all 97 files.
- Root reran the focused epoch SQLite suite: **10 tests / 23 assertions**, exit
  0. Coverage includes stale confirmations, duplicate initialization, audit-failure
  rollback and preservation of caller transactions and retained history. This does
  not substitute for MySQL locking or a full restored-history rehearsal.
- Root's full PA Workflows regression (runner 32107) completed with exit 0:
  **950 tests / 7,060 assertions / 44 skipped**. Skipped fixtures remain unverified;
  this run is not production acceptance.
- Still required: epoch enforcement in API reads/writes/replays and snapshots,
  coordinated restore maintenance, durable Ops epoch pins, reconciliation of old
  commands and mappings, and the refresh consumer. Neither the new CLI nor the
  migration automatically detects an external restore. No production changes or
  cutover are claimed by this checkpoint.

### Epoch-bound receipt execution checkpoint

- PA's shared command executor now supports a transaction-bound history fence
  before resource authorization. Additive migration 0098 stores the verified
  epoch on opted-in receipts; legacy rows remain NULL. Replaying a different or
  unknown epoch, or replaying a fenced receipt through an unfenced caller, fails
  before result decoding and successful-attempt recording. Existing unfenced
  command families retain their previous execution behavior.
- Root reviewed the executor, schema and focused tests. Root's selected command,
  directory, project and epoch workflow regression passed **164 tests / 1,034
  assertions**. CLI guard tests passed **3 tests / 28 assertions**, using invalid
  database settings so no connection was attempted. Migration-file validation
  accepts all 98 files.
- Disposable real MySQL runner **34259** passed **5 tests / 101 assertions**:
  existing project HTTP cases, actual 0097/0098 fixture migration, epoch rotation,
  audit-unavailable rollback, retained source/history, and a second connection
  blocked by the authoritative history lock until its transaction ends. Earlier
  runs exposed fixture collation drift and privileged trigger requirements;
  the fixture now matches baseline/0064 and injects audit unavailability by an
  exact reversible table rename. Database privileges were not broadened.
- These tests do not prove HTTP epoch enforcement: adapters do not yet supply
  the new fence. Next wire mandatory expected epoch through capabilities,
  project read/create/update/bind, receipt responses and Ops durable state,
  then test cross-epoch retries and restored snapshots end-to-end. Restore
  maintenance and the pending project refresh consumer remain incomplete.
- All changes remain local/unreleased. No production migration, public-link
  mutation, retention change, or PA release occurred at this checkpoint.

### Project HTTP history enforcement checkpoint

- PA project create/update, bind and single-project read now require canonical
  `X-PA-History-Epoch`. Missing/malformed input is rejected before database work;
  stale history is rejected transactionally before resource authorization or
  receipt exposure. Missing/malformed stored history is unavailable, not silently
  initialized. The front controller forwards the header explicitly.
- Capability discovery rechecks current credentials in a dedicated transaction,
  reads locked source/history metadata, returns `historyEpoch`, and advertises
  `requiresHistoryEpoch: true` for the three project endpoint entries. Project
  success envelopes echo their verified epoch. Existing capability discovery
  now also requires explicit initialized history; release preparation must
  include that operator step, not an automatic migration default.
- Root's selected command/directory/project/capability/epoch regression passed
  **179 tests / 1,135 assertions**, exit 0. Disposable real HTTP/MySQL runner
  **7934** passed **6 tests / 118 assertions**. The new HTTP case creates a
  receipt, rotates the fixture epoch, rejects its stale header with 412, then
  rejects the old receipt under the new header with 409. Receipt and successful
  attempt counts remain unchanged. This simulates an epoch transition, not a
  complete database restore.
- The PA-only HTTP test does not exercise the joined Ops transports. Those still
  need mandatory expected-epoch configuration, metadata/response validation,
  headers, durable reservation/mapping pins and joined fixture updates. Do not
  deploy either side until that pairing and restore/reconciliation checks pass.
  Directory/snapshot/feed fencing and global restore maintenance also remain
  outstanding. No production changes, public-link changes or release occurred.

### Paired project transport checkpoint — September 12

- Ops capability discovery now validates and reports PA's canonical history
  epoch. Project create/update, binding and reads require an explicitly configured
  expected epoch before network access, require the endpoint's advertised fence,
  and compare both capability and success metadata against that snapshot. They
  send `X-PA-History-Epoch`; probe metadata never silently changes the pin.
- Directory mock capabilities were updated to the new PA discovery contract;
  directory command bodies and success envelopes remain unchanged. This is
  compatibility coverage, not completed directory history fencing.
- Root run **4306**, terminal exit 0: **197 tests across 6 files**, including the
  three project transports, shared capability probe and directory regressions.
- Root paired actual HTTP/disposable-MySQL run **9330**, terminal exit 0:
  **8 tests / 171 assertions**, plus nested Ops assertions. Synthetic joined
  fixtures require the parent PA epoch. Verified cleanup removed only the
  disposable test container. No production systems were used.
- Additive Ops migration 0064 and durable reservation/mapping/refresh epoch
  checks are being implemented and have not yet passed their final root review
  and regression run. Old rows must remain explicitly unreconciled, never be
  backfilled from a probe. A durable pin change needs a reviewed reconciliation
  procedure; command history and public links must remain intact.
- Remaining gates include durable queue validation, refresh and feed consumers,
  directory fencing, full restore rehearsal and coordinated owner-reviewed PA
  deployment. No release, remote migration or production acceptance is implied.

### Durable project pins and paired directory checkpoint — September 12

- Additive migration **0064** preserves old project destinations, outbox records,
  mappings and refresh obligations with NULL epochs. New rows require canonical
  UUIDv4 pins and exact parent identity; pins cannot be silently changed. The
  queue snapshots validated configuration, verifies the claimed epoch and fresh
  authority, and acknowledges mapping/refresh state atomically under its lease.
  Historical or rotated pins require reviewed reconciliation, not automatic
  adoption from capability discovery.
- Independent review corrected permissive SQL UUID matching, configuration
  accessors, explicit post-claim epoch checks and the visibility of incompatible
  terminal records. Root frozen rerun **22548** passed **34 tests / 4 files**,
  including the real **0001–0064** migration chain; root type check **83091**
  exited 0. Earlier first pass **93146** also passed 34 tests.
- Root readback found the terminal-record diagnostic change had not landed in
  the frozen queue. The explicit predicate and unchanged-row regression are now
  applied; follow-up **27775** passed **21 queue tests**, terminal exit 0. This
  supplements, rather than inflates, the earlier combined-suite result.
- PA directory organization/client commands now enforce history before resource
  authorization and receipt replay, and include the verified epoch in responses.
  Optional internal service hooks retain standalone compatibility, not an HTTP
  bypass. Root selected PA workflows passed **180 tests / 1,150 assertions**.
- Paired directory transports require the configured pin, exact endpoint metadata
  and matching responses. Root's five transport suites passed **189 tests**.
  Actual Ops-to-PA directory HTTP/disposable-MySQL runner **96349** exited 0:
  **8 parent tests / 197 assertions**, plus nested Ops checks. It covers response
  loss/replay and rejects stale/cross-epoch receipt reuse without domain/history
  mutation. The reviewed harness cleans up only its labeled synthetic container.
- **0065 directory durability is in progress, not verified:** pins must originate
  in canonical directory destinations/intents, survive materialization into the
  outbox, and match acknowledged mapping/receipt proofs. Directory settlement
  also needs the project's explicit lease-expiry checks, not only lease tokens.
  The older directory queue/materializer tests do not establish compatibility
  with the new mandatory transport pin; rerun the whole chain after pairing.
- No remote D1 migration, public-link change, retention change, PA release or
  authority cutover occurred. Full restore/reconciliation, inventory/feed and
  refresh consumers, normal user workflows and production acceptance remain open.

### Directory migration integration findings — September 12

- Root extended the synthetic migration rehearsal through **0001–0065**. It
  explicitly compares preserved historical intent rows with only the new NULL
  epoch column added; the migration must not invent enrollment or adopt history.
- Root type check **10371** exited 0. Combined local D1 run **12953** exited 1:
  **7 passed / 50 failed across 5 files**. The three full-chain tests passed;
  this is not a passing directory integration checkpoint or release approval.
- The run exposed a real additive-migration omission: the old create-admission
  shape trigger still accepts exactly five destination properties, rejecting the
  new required history epoch. Migration 0065 must replace that trigger while
  preserving all scope, duplicate, and active-authority checks. Its intent-write
  guard also needs exact epoch equality with the authorized destination JSON.
- Independent review fixed malformed connection identity handling and predecessor
  epoch checks. Additional predecessor destination equality checks are required
  in SQL and the materializer. Outbox fixtures also need the advertised mandatory
  history fence and valid mapping setup; malformed-JSON tests must supply a valid
  epoch so they continue testing JSON validation rather than an unrelated guard.
- Terra owns those bounded corrections. Root must rerun the five-suite snapshot
  and type check after they stabilize. No tests remain running from run 12953.
  No production write, deployment, retention change, or public-link change occurred.

### Runtime connection gate — September 12

- Root search and independent read-only review confirm the canonical directory
  store/read/materializer/outbox currently have no production route or scheduler
  callers. Their isolated tests do not prove the requested customer workflow.
- The next vertical implementation must connect native authenticated customer
  viewing/editing to server-loaded enrolled destinations, durable local revisions,
  and bounded materialization/dispatch/reconciliation. PA downtime must not undo
  a successful authorized local edit. The Clients interface must expose the same
  canonical state rather than silently editing the old PA projection tables.
- Required dispatch prerequisites: an explicitly reviewed source/application/epoch
  credential resolver, and fresh authorization of the command's original local
  actor on every retry. The directory verifier currently receives configuration
  only; extend it with the claimed immutable origin before implementing runtime
  dispatch. Do not substitute route-time authorization for retry-time checks.
- Creation also requires a current-authorized admission issuer and reviewed
  onboarding/backfill. An edit-only first wiring slice does not satisfy creation
  or migration acceptance. Never lazily adopt PA projection rows or accept
  browser-selected destination authority to bypass these prerequisites.

### Corrected directory migration test checkpoint — September 12

- Root run **61200** exited 0: **46 tests across 4 files**, covering the actual
  0001–0065 chain, canonical storage, write authority and materialization. The
  admission trigger now accepts the exact six-field destination contract with
  a canonical epoch; direct malformed/missing epochs are rejected. Existing
  history remains unchanged except for nullable added columns. Intent writes
  are bound to the authorized destination epoch, and predecessor checks include
  the exact record, destination and epoch in both SQL and the materializer.
- Queue run **37506** found two fixture errors: a row-object read used as a
  timestamp and an update success envelope missing its mandatory epoch. Root
  corrected those without weakening production checks. Rerun **38068** exited 0:
  **14 queue tests**, including no fetch against another epoch, malformed
  authority rejection, expired-lease acknowledgement fencing and stable replay.
- Root type check **58246** exited 0. These are separate focused runs, not a full
  application test result, runtime rollout, or production acceptance.
- Next: retry-time authorization must receive immutable originating command
  context. Root also found authority-error/mismatch release branches using the
  invocation time instead of the settlement time for lease-expiry fencing;
  cover a slow authority callback before runtime dispatch is connected. Sol is
  preparing that bounded correction. No test runners remain active at this
  checkpoint, and no production resources or existing client links were changed.

### Incoming compatibility checkpoint — September 12

- Root reran `incoming-page`, `incoming-rclone-plan`, and `incoming-upload-status`:
  **29 tests across 3 files passed**. Reviewed assertions cover conditional access
  codes, accessible file picking, submitted-name ready paths with collision-safe
  suffixes, Windows-safe path limits, and honest separation of publication from
  server pickup. Missing R2 objects are not treated as delivery receipts.
- This is local template/path/status coverage, not rendered browser QA, live
  upload-email verification, TrueNAS acceptance, or proof of deployed revision.
  Retention and the existing hourly PULL/MOVE configuration remain unchanged.

### Runtime implementation in progress — September 12

- Native GET/PATCH `/api/directory/records/:recordId` handlers are now implemented
  locally and registered behind the existing global staff authentication and
  mutation-security middleware. They use server-loaded enrolled destinations;
  old PA projection rows are not implicitly adopted. Local save and persisted
  intent states must remain distinct from remote synchronization success.
  Route tests and integration review are still pending at this checkpoint.
- Retry verification now receives a deeply frozen claimed reservation, and a
  separate native-actor adapter resolves its canonical record through exact
  materialization/intent/audit links. Slow authority callbacks must not release,
  settle, or send using an expired lease. The root run **34069** passed all 15
  materializer tests but exposed two outbox fixture problems (race winner and
  hard-coded retry time); corrected outbox tests are being rerun. This is not
  yet a passing combined retry checkpoint.
- Configuration review found reusable server-only connector credential-reference
  resolution, but generic application UUID/source UUID/history epoch pins still
  need explicit reviewed runtime configuration. Repository configuration is not
  evidence of deployed secret values. Do not infer these pins from application
  keys or capability discovery, broaden old credentials, or invoke legacy
  reconciliation in a way that hides existing customers/public links.
- Remaining runtime gates include the reviewed resolver, mandatory retry actor
  adapter wiring, bounded scheduler/drain, canonical onboarding/backfill, and UI
  permissions/navigation. The existing Client Hub visibility still depends on
  legacy permissions; new handlers alone do not complete native staff access.

### Retry authorization and initial runtime routes verified locally — September 12

- Root rerun **11271** exited 0: **17 directory queue tests**. The earlier
  materializer portion of **34069** passed **15 tests**, including the native
  actor adapter. Verifiers receive deeply frozen original command/destination/
  actor context; expired verification success, rejection, or exceptions do not
  send or settle under an expired lease. The adapter checks exact canonical
  materialization bytes, destination identity, epoch and original record version
  before current native view/edit grants. Runtime composition must still make
  this adapter mandatory; a callback interface alone does not enforce policy.
- Root route-only run passed **8 mocked Hono request tests**. The subsequent
  combined route/request-security/R2-mutation-classifier run passed **18 tests**.
  Request bodies are byte-limited while streaming, including missing or false
  Content-Length; destinations and actor identity are server-derived. Replies
  use stored intent states, including replay of acknowledged work. Root added
  negative classifier coverage for unrelated verbs, extra segments and encoded
  path separators. Global authentication registration was read back in index;
  these tests do not constitute live Access authentication acceptance.
- Root type check **42327** exited 0. The route-to-real-D1 integration fixture is
  next, followed by the reviewed credential resolver, mandatory authority adapter,
  scheduler/drain and client-facing UI. No release, remote migration, PA update,
  public-link change or production authority cutover occurred.

### Real database route verification and isolated configuration — September 12

- Root run **2862** exited 0: **6 tests across 2 files**, covering the real
  D1/Hono directory route fixture and the initial isolated API v2 configuration
  resolver. The route fixture applies migrations 0001–0065 and verifies persisted
  revisions, original-actor audit records, epoch-pinned intents, replay without
  duplication, stale-version rejection, forged destination rejection, and revoked
  or unrelated staff denial. It injects an authenticated principal for testing;
  this is not live Access login acceptance. The local edit performs no PA fetch.
- The new secret-only resolver is separate from the legacy connector manifest;
  it does not reconcile, adopt source identities, broaden old tokens, or mutate
  existing source visibility. It requires exact durable source/application/origin/
  source-instance/history-epoch identities and returns detached frozen config.
  No new deployment binding or production secret has been installed.
- Independent Sol review identified two additional input-boundary corrections:
  reject accessor/symbol/non-enumerable resolver identity inputs, and reject
  credential whitespace normalization or non-header-byte characters. Luna is
  adding those corrections and regression tests; the initial passing run does
  not establish coverage of those corrections.
- Next runtime gate: derive create/link proof and original actor authority from
  durable server-owned records before composing a bounded materializer/dispatcher.
  Do not substitute a currently signed-in browser session or inferred email for
  the original mutation identity. Production remains unchanged.
- Runtime composition review confirmed that materialization currently validates
  the shape of `authorizationId`/`linkProofId` but does not resolve them against
  durable proof records. Before scheduling outbound work, add server-issued
  immutable create/link evidence bound to exact intent, destination, and epoch.
  Also persist the mutation's original verified subject binding and compare it
  with current active native admission on retries. A current admission subject
  alone is not proof of the historical binding after an identity change. These
  are remaining implementation dependencies, not a need for user credentials or
  permission, and the goal remains active.
- The configuration corrections are now implemented and root-reviewed. Root's
  targeted rerun at **11:12:45** exited 0 with **6 configuration tests**. It covers
  descriptor-safe identity snapshots (including an own `__proto__` key), opaque
  proxy failures, exact matching, and credential byte/whitespace validation.
  These local results do not enable outbound synchronization or constitute a
  release. The new resolver remains intentionally unwired pending the durable
  proof and original-identity work above.
- Root TypeScript check **98841** also exited 0 after those corrections.

### Original actor identity and directory field compatibility — September 12

- The previous goal turn made concrete progress: the real D1 route fixture,
  isolated configuration resolver, independent input-boundary corrections, and
  root tests/typecheck completed. No process from those runs remains active.
- Current source confirms native admission subjects can change with a version
  increment (migration 0061). Saving only an actor staff ID is therefore not
  enough historical identity evidence for delayed edits. An additive audit
  subject column and exact live-write-fence validation are being implemented;
  historical NULL subjects must remain unknown, not be inferred from today's
  staff admission. Retry must compare original and current identity separately.
- Root verified a field mismatch against PA's actual
  `GenericDirectoryCommandInput.php` and database baseline: client state/postal
  fields are limited to 2/20 characters, whereas organizations use 100/32.
  Operations previously accepted 100/32 for both. Route validation now rejects
  incompatible client input before saving, preserves organization limits, and
  does not truncate data. Root's **11:17:36** route/config run passed **16 tests
  across 2 files**. Canonical store validation is being aligned as well so
  non-HTTP callers cannot persist an unsynchronizable profile. Broader address
  support would require a coordinated PA schema/contract change, not silent
  transport coercion.
- These are local implementation checks only. No PA production changes, remote
  migration, source enrollment, public-link rewrite, or retention change occurred.
- Migration `0066_operations_directory_original_actor_subject.sql` and the
  store/retry changes are now implemented locally. Root run **79537** finished
  with **63 passed / 5 failed tests across 6 files** (303.70 seconds). The
  write-authority, complete migration-chain, real-D1 route and outbox files
  passed. Failures in the store/materializer fixtures match source review:
  lightweight fixtures referenced the later admission `version` column without
  applying its migration; forged-audit setup was rejected before reaching the
  intended guard; invalid-address setup reused an incompatible admission; and
  an old test expected unsupported client fields to persist. Test-only
  corrections are in progress. Do not report this as a passing combined run.
- Historical NULL preservation is covered by the migration-chain test. Separate
  old-NULL dispatch rejection and same-identity/rebound-identity tests still need
  completed execution before claiming their acceptance coverage.
- Root rerun **37986** exited 0: **34 tests across the corrected store and
  materializer files** (138.37 seconds). Root additionally guarded legacy-NULL
  materialization in both the helper and an additive 0066 SQL trigger, without
  deleting or modifying existing reservations. TypeScript check **12939** exited
  0. A separate historical fixture now performs genuine pre-0066 fenced writes;
  root corrected its stored command/origin serialization to match the real
  canonical bytes, so an unrelated byte mismatch cannot explain actor denial.
  The historical fixture, full migration chain, and real-D1 route are being
  rerun together; that final selection remains pending at this checkpoint.
- Root run **56726** passed the full migration chain and real-D1 route, but the
  old-materialized-row fixture failed its existing metadata fence because the
  fixture mixed canonical wire JSON with differently ordered stored profile
  JSON. Root corrected all historical fixture snapshots to the real canonical
  representation. The final **11:33:28** historical-fixture rerun exited 0:
  **2 tests passed**. This verifies preservation of an already pending legacy
  reservation with NULL original subject and adapter denial, plus preservation
  of a ready legacy intent with helper/SQL rejection of new materialization.
  The preceding corrected store/materializer selection remains **34 passing
  tests**; complete migration-chain and real-route acceptance remain local, not
  a production migration or cutover.
- Next implementation work is explicit new-versus-existing remote enrollment
  evidence and the generic PA directory binding endpoint described in
  `directory-authority-migration.md`, followed by bounded runtime dispatch and
  reconciliation. Those are unfinished code dependencies, not a user-access
  blocker. No live credentials, public links, incoming objects, retention rules,
  or PA production settings were changed during this increment.
- Final root TypeScript check **25116** exited 0; all test processes in this
  increment are terminal.

### September 12: explicit existing-directory binding API

- Implementing generic, separately scoped client/organization identity-binding
  endpoints in the PA worktree. These do not create customers, edit profiles,
  grant access, select a directory manager, initialize missing sync state or
  enable production API flags. Existing write/full tokens do not gain binding
  authority. The exact capability and wire contract are documented in PA's
  `docs/reference/generic-api-v2.md`.
- Root baseline **9beb9b** passed **58 tests / 389 assertions** covering existing
  project bindings, external resource bindings, directory projections,
  management policy, capabilities and scope policy. New production-file syntax
  checks passed. A later attempted selection **2e51fc** could not load the
  then-in-progress new test because of a closure syntax error; it is not a
  passing combined run. Final new endpoint tests remain pending at this entry.
- Root review rejected historical customer projections in binding receipts:
  current access after an organization transfer cannot authorize disclosure of
  the former profile. The result now contains only permanent/external identity
  and historical binding revision. Independent Terra coverage, strengthened
  and rerun by root as **9d61ef**, passed **1 test / 24 assertions**: organization
  transfer exposes no historical profile; current-organization revocation denies
  replay and leaves binding/audit/receipt/attempt state unchanged.
- Root also caught a front-controller body-read gate using project API settings
  for directory bindings. The source now uses directory settings. Transport
  regression coverage remains required before release.
- Sol's read-only review confirmed unchanged legacy rows generally have no
  directory-specific revision. Generic GET and an explicit audited bootstrap
  remain necessary before importing those rows. Legacy snapshot versions are
  not substitutes. This remaining work is documented in
  `directory-authority-migration.md`; binding alone is not completed migration.
- No PA release, remote database migration, production authority change,
  credential update, public-link rewrite, incoming-object or retention change
  was performed in this increment. The PA owner review/deployment gate remains.
- The source/test slice is now stable. Root's final selected run **3b2e77**
  passed **76 tests / 533 assertions**. This includes separate SQLite dispatcher
  tests using real generic authentication, both directory kinds, strict scopes,
  resource grants, source/application/history fencing and replay, minimal
  receipts, malformed transport, stale/missing state and no domain mutation.
  Root added organization invariance, legacy-namespace rejection, stale revision,
  unrecorded edit, immutable-target collision and late audit/attempt rollback
  checks. Capability advertisement is gated without granting token permissions.
- Independent actual front-controller loopback tests, reviewed and rerun by
  root as **721e20**, passed **2 tests / 10 assertions** (also included in the
  76-test selection). With directory enabled and projects disabled, both binding
  paths correctly read valid JSON and reach the required source-header gate;
  disabled directory returns 404. This test uses no database and pins a dummy
  local database target to protect against accidentally inherited configuration.
  It is transport/routing evidence, not authenticated HTTP/MySQL acceptance.
- Full local PA suite **57962** has started and remains pending at this entry.
  No MySQL-backed new binding HTTP acceptance or production acceptance has been
  claimed. All agents' individual test runners are terminal.
- Full suite **57962** finished: **1,182 tests, 8,652 assertions, 1 failure,
  96 skipped**, in 237.873 seconds. The only failure was the existing directory
  capability-advertisement test expecting three endpoints rather than the now
  correct five. Root updated that expectation, asserted both binding paths and
  confirmed neither bind capability was granted to the existing writer token.
  Expanded root rerun **4a3f62** passed **134 tests / 830 assertions**, including
  the corrected directory dispatcher file and every new binding test. The full
  suite has not been rerun after that test-only correction; do not describe it
  as an all-green full-suite result or count skipped tests as acceptance.
- All runners are now terminal. Next: generic single-resource directory reads
  and explicit audited existing-record bootstrap, then durable Ops linking
  evidence and dispatch composition. Authenticated HTTP/MySQL rehearsal,
  both-instance migration/cutover and owner-assisted PA deployment remain open.

### September 12: directory reads and initialization approval boundary

- Added single-resource generic PA directory GET services/dispatchers and exact
  client/organization read capabilities, under existing directory gates. Current
  authentication, resource/parent-organization authority, source/history pins,
  authorization generation and exact present directory revision/hash are checked
  transactionally. GET does not initialize missing state or return private fields.
- Root corrected canonical UUID validation and restored test environment values
  between runs. Capability-registry tests now address endpoints by path rather
  than relying on ordering. Root explicit-file regression **881ecd** passed
  **139 tests / 865 assertions**. Subsequent root read tests **61a333** passed
  **6 tests / 55 assertions**, including revoked credentials, unavailable clients
  and malformed revisions; root actual loopback front-controller test **b7ed9b**
  passed **3 tests / 18 assertions**, including both new GET routes.
- Initialization remains a separate permission gate. The approval reviewer
  rejected adding `directory.clients.initialize` and
  `directory.organizations.initialize` because they broaden the authorization
  catalog without a corresponding authorized endpoint or explicit informed
  approval. No retry, indirect catalog modification or substitute privilege was
  attempted. Root requested explicit approval for those capabilities and their
  workflow, explaining the limited synchronization-baseline write and unchanged
  existing tokens/production settings.
- Before that stop, isolated initialization Input/Service/test drafts were
  created locally. They remain unregistered, unverified and unreleased. One
  draft test defines `count()` and collides with PHPUnit's final method: broad
  discovery attempt **982428** terminated before tests. The successful read-only
  regression used an explicit file selection excluding initialization, not a
  changed permission catalog or mocked bypass. Do not claim full-suite green.
  Resolve the draft test name and verify initialization only after the requested
  authority is obtained; retain files and historical records meanwhile.
- No PA deployment, production migration, initialization, enrollment, public-link
  change, credential grant or retention change was performed. Initialization is
  awaiting owner input; other goal work and read-only QA remain available.
- Final root explicit-file regression **3b4c13** passed **141 tests / 897
  assertions** after the added GET/front-controller cases. It explicitly excludes
  the stopped initialization drafts. Root lint and tracked-file whitespace
  checks **1c2ad8** passed. No runner remains active at this checkpoint.

### September 12: Incoming verification under non-destructive continuation

- Revalidated existing local Incoming form, readable pickup naming, status,
  promotion, reconciliation and retention changes: six suites, **47 tests passed**
  (root run `6cccf9`, completion `f86410`). The first sandbox attempt failed before
  test discovery on esbuild directory access; the approved elevated local run
  completed without dependency or lockfile changes.
- Existing headless Edge Incoming tests passed **8/8**, desktop and mobile
  (`2bce71`). These use synthetic files and intercepted requests, not production
  uploads. Coverage includes centered controls, narrow-screen containment,
  protected access-code input, direct upload bytes, cancellation and resume.
  Root also inspected generated desktop dropzone and narrow identity screenshots.
- Operations TypeScript validation (`tsc --noEmit`) passed (`017443`, completion
  `884bc7`). Dependencies already supported these runs; no reinstall was needed.
- New publication plans use the submitted uploader name, persisted upload date
  and stable collision discriminator under `ready/`, with bounded safe filenames.
  Existing journal paths remain stable; no existing object was moved or renamed.
- This is local acceptance evidence, not proof these exact changes are deployed,
  that live Turnstile succeeded, or that an email/server pickup occurred. Keep the
  owner's confirmed hourly TrueNAS PULL/MOVE from `ready/` and retention unchanged.
  No production deployment, migration or public-link change occurred in this check.

### September 12: Operations directory-read adapter

- Added `project-alpha-directory-read-api-v2.ts` against the actual PA
  GenericDirectoryReadService/Dispatcher/ProjectionService response. It probes
  the exact client or organization GET endpoint and read scope, pins configured
  source/application/history before awaiting network responses, and preserves
  string revisions and authorization generations without numeric rounding.
- Reads are bounded (64 KiB response; separate 10-second preflight and read
  attempts), reject redirect/session/foreign-profile responses, and expose only
  typed outcomes with safe correlation IDs. Raw nullable legacy profile strings
  are preserved within the body limit rather than applying write normalization.
  No local persistence, new credentials, runtime route/scheduler wiring or
  production configuration is introduced by this module.
- Sol's focused suite passed 11 tests and TypeScript checking. Root reviewed the
  implementation against PA and added a separate identity-fence suite, including
  source/application/history/request/resource mismatches, foreign nested fields,
  malformed revisions, response headers, and no write fallback after HTTP 409.
  Final root regression **d85c93**: **165 tests passed across six files**.
  Root TypeScript **f5f2e0** / **4e1cc2** passed. All runners are terminal.
- Corrected M03's stale full-suite-green summary. The current initialization
  approval/discovery blocker and the PA owner review gate remain intact. Read
  success does not supply reviewed binding/adoption proof or portal authority;
  durable proof acquisition, initialization approval, dispatch/consumer wiring,
  joined HTTP/MySQL acceptance and coordinated release are still required.

### September 12: native staff target-scope policy

- Added a pure, version-1 native staff target-scope evaluator and focused tests.
  It uses exact native admission/subject, known capabilities, all active target
  memberships, global/business-area/division/exact-staff scopes, and deny-wins
  decisions with matching row IDs for later effective-access explanations.
  Identity recovery remains out-of-band regardless of ordinary delegation.
- Root review caught inactive historical memberships being treated as invalid
  current memberships. Corrected the evaluator to ignore those historical rows
  for both scope matching and parent validity; it retains them unchanged. Active
  memberships with invalid parents still fail closed. Added transfer tests,
  including an obsolete division deny that must not follow a transferred person.
- Bounded descriptor-safe arrays reject sparse/accessor/custom-prototype input;
  the exact capability list is runtime-frozen. Root added all 16 allow/deny scope
  combinations, order independence, multi-membership denies, unrelated actor or
  target scopes, subject-case preservation and no expansion of old capabilities.
- Existing native identity/directory/admin baseline **681692** / **0861c3** passed
  **46 tests**, including disposable local D1 transaction tests. Final pure policy
  regression **bfa28e** passed **63 tests across three files**. TypeScript
  **dc56ca** / **386c3c** passed; no runners remain active.
- Corrected the management plan's stale migration-0062 instruction: 0062–0066
  already belong to project/directory work. No migration was created or renamed.
  The future management schema must allocate the next unused number.
- This target-scope result is not complete mutation authorization. Trusted native
  row loading, row-version evidence, grant/delegation ceilings, transactional
  rechecks, last-admin protection, onboarding/recovery, routes and UI are still
  required before activation. No live staff access, PA data, credentials, public
  links, retention, or production settings changed.

### September 12: transactional native staff admission revocation

- Added local migration `0069_native_staff_management_commands.sql` and
  `executeNativeStaffManagementCommand`. The versioned ledger is generic, while
  the currently supported command is explicitly limited to admission disable.
  Other management capabilities remain unimplemented and cannot be invoked via
  this entry point. No runtime route or bootstrap authority was enabled.
- The real D1 batch checks current exact-subject native identity, native profiles,
  legacy/new same-action target scopes and denies, active membership parents,
  expected admission version, actual mutation count and immutable audit. A
  post-mutation candidate assertion prevents removal of the last complete
  administrator. Self-disable requires an independently surviving candidate;
  a disabled actor cannot replay. No PA user or role is inferred or changed.
- Root review added fence insertion prestate checks, immutable fence identity and
  counter transitions, receipt freezing, exact replay-version validation and
  descriptor-safe batch acknowledgement checks. Direct audit-only insertion,
  fabricated consumed fences and receipt replacement are rejected.
- Initial combined run **d1f7a9** / **e2245c** failed positive command tests.
  Focused diagnostic **dee429** / **5008ac** identified D1's expression-depth
  limit when expanding the candidate view inside the audit predicate. Moving
  that assertion into a separate aborting trigger in the same transaction
  preserved its protection. Focused rerun **2ddc90** / **6d30d9** passed; temporary
  synthetic diagnostic instrumentation was then removed.
- Final combined run **b885b7** / **2005d3** passed **31 tests across four files**
  in 135.81 seconds. It covers the actual 0001–0069 chain, the old command suite,
  the new command and independent regression cases. Final TypeScript run
  **739c69** / **a72f2f** exited successfully. All observed runners are terminal.
- Independent cases include permission revocation immediately before the batch,
  scoped and legacy denies, wrong/rotated subjects, stale versions, late audit
  failure with full rollback, two competing administrator removals, immutable
  input/receipts, and a committed write followed by a malformed acknowledgement.
  The latter is resolved by exact retry; an uncertain response is not called a
  rollback. The old command also runs against the new full migration chain.
- **Still incomplete:** other management commands, onboarding, recovery,
  operational effective-access/impact completion, reviewed authority upgrade,
  routes/UI and native-authentication cutover. The legacy service is preserved
  for compatibility but must not remain an alternate ordinary revocation route
  after cutover. No migrations, worker deployments, PA releases, public-link
  changes or production staff revocations were performed in this checkpoint.

### September 12: SQL control-plane candidate projection

- Added local migration `0068_native_staff_control_plane.sql`, an advisory view
  returning each independently complete candidate with bound subject and
  admission/profile versions. It requires all six global actions and all 44
  grant-effect/operation combinations for the same person, and honors scoped
  denies and inactive membership parents. Existing 0061 meanings are unchanged.
- Root tests apply the actual 0001–0068 migration chain and verify empty initial
  authority. A separate real D1 concurrency test uses a test-only assertion table:
  exactly one of two competing admission removals commits, with the other
  mutation rolled back when no candidate would remain.
- Initial runs **891ed1** and **d33b23** failed before fixtures; the isolated
  diagnostic **1abc43** confirmed migration 0068 hit a compound-SELECT limit.
  Replaced literal UNION lists with VALUES without changing the authority rules.
  Final run **f833c3** / **64c36b** passed **34 tests across five files** in
  90.17 seconds. Final TypeScript check **088599** / **24394e** exited successfully.
- Independent review confirmed that any qualifying nonempty deny ceiling blocks
  at least one of the required 44 tuples, so SQL rejection matches the pure
  candidate policy. The SQL view assumes validated writers and does not replace
  runtime subject validation or verification of a caller's Access identity.
- No grants, bootstrap upgrade, blocking production triggers, runtime routes or
  deployments were introduced. The concurrency test is not a shipped command:
  mutation authorization, version/audit/replay fences and coverage of all
  authority-changing commands remain required before activation. Goal incomplete.

### September 12: database-backed native staff management reads

- Added `native-staff-management-read.ts` and two test files. One first-primary
  D1 SELECT batch loads native actor/target identity, current memberships and
  old/new management authority. Requested input is copied before awaiting.
  No PA role, email matching or caller-supplied grants establish authority.
- Actor authorization and target inspection are separate. Profile-read output
  contains no permission snapshot. Management inspection contains target-only
  authority and no profile email, with an explicit `partial: true` marker.
  This is not yet a complete operational access report or revocation impact UI.
- Legacy 0061 remains limited to its two original capabilities. New rows require
  the exact contract/domain. Namespace-qualified hashed references prevent a
  legacy/new raw-ID collision from merging a deny/allow or mislinking a ceiling.
  Returned current-state snapshots and nested rows are frozen.
- Independent review corrected opaque Access-subject handling, exact target
  scope validation, version/domain loading, inactive-history exclusion and
  descriptor-safe database-result validation. Independent tests cover profile
  privacy, target separation, colliding IDs, request mutation during await,
  accessors, wrong subject, actor revocation and unsupported read capabilities.
- In-memory transformations of real disposable D1 batch responses verified
  rejection of future contracts, incompatible target scopes, fractional flags,
  malformed profile data, failed responses, row-array getters and overflow.
  Stored data and database constraints were not disabled for these checks.
- First run **3f6694** / **27b06d** passed 44 tests; TypeScript identified a
  widened membership scope type. After the type correction and added response
  checks, final run **44b134** / **38df1e** passed **46 tests across five files**.
  TypeScript **5c8efc** / **843846** passed. All runners are terminal.
- Still required: transactional mutation commands/audit fences and SQL last-admin
  enforcement; full operational grants/impact composition; pending onboarding,
  recovery, authenticated routes/UI and live acceptance. These read helpers are
  not wired into production authentication. No deployment, PA change, new live
  authority, public-link change or retention change occurred.

### September 12: additive staff authority storage

- Added local migration `0067_native_staff_management_authority.sql`: an exact
  frozen 18-entry version/domain capability catalog, new management delegations
  and persisted delegation ceilings. It seeds no authority, admission or profile.
  It does not modify the meaning or contents of migration-0061 delegations.
- Ceiling grant effects and create/revoke operations have separate strict integer
  flags. Domain-specific scope checks, direct and compound foreign keys, immutable
  identities, version increments and durable rows enforce storage integrity.
  Active parent authorization still belongs to every policy/command evaluation;
  retaining a ceiling after parent revocation is historical, not effective access.
- Root review found SQLite replacement could bypass delete-only history guards.
  Added insertion-collision guards and verified both primary-key and natural-key
  `INSERT OR REPLACE` attempts fail with recursive triggers disabled. Explicit
  NUL-ID and fractional flag/version rejection are covered as well.
- Initial D1 run **032613** / **1c1afe** failed three schema fixture cases: a
  missing count alias and an unseeded resource caused the failures and a dependent
  no-row mutation assertion. Corrected those fixtures, retaining real pre-0058
  resource history through the upgrade; no production data or guards were bypassed.
- Final local run **edcb50** / **a4e8eb** passed **42 tests across five files**,
  including the real 0001–0067 migration chain, exact SQL/TypeScript catalog parity,
  unchanged legacy admission/delegation history, empty new authority tables on a
  fresh migration, existing transactional staff administration and candidate
  policy tests. Foreign-key checks passed. TypeScript **6b4fd8** / **8dbb00**
  exited successfully. All runners are terminal.
- Next: trusted complete native-row loading with legacy/new table provenance,
  transactional command/audit schema and SQL last-admin enforcement, then pending
  onboarding, recovery, routes and UI. Migration 0067 is not deployed; native
  authentication and the production authority switch remain disabled/unperformed.
  PA initialization permissions remain a separate approval gate. The full goal
  remains active and incomplete.

### September 12: complete administrator candidate proof

- Added `native-staff-control-plane-policy.ts` and two test files. This advisory
  evaluator requires one person's active exact-subject admission, matching native
  profile, all six global management actions and all 44 global delegation
  capability/effect/operation combinations. It cannot combine partial authority
  from different people. No ordinary identity-recovery authority is conferred.
- Root review fixed scoped ceiling denies being dropped while selecting global
  allow parents, and an actor field being read before nested descriptor validation.
  Tests cover both cases, including a deny attached to an exact-other-person
  parent, inactive-parent contrast and a zero-invocation accessor assertion.
- Independent coverage removes each of the 44 required combinations separately,
  each of the six actions separately, and tests that a global-looking ceiling
  attached to a scoped parent cannot prove global management authority.
- Final synthetic regression **ece50f** passed **111 tests across seven files**.
  Final TypeScript check **bdb4f2** / **b18609** exited successfully after fixing
  an incorrectly narrow type in the test fixture. Both runners are terminal.
- Inspected the actual 0061 SQL/command service: its existing last-admin guard
  covers only the original two-action contract. It does not implement this new
  invariant. The additive management schema, authoritative row loader, atomic
  commands and concurrent-removal tests are still required before activation.
  No PA scope initialization, bootstrap upgrade, migration, release or live
  access change was performed. The broader goal remains incomplete.

### September 12: native staff delegation ceilings

- Added a pure delegation-ceiling evaluator. It derives the required management
  action and evaluates current target authority itself; a caller-supplied allow
  flag cannot authorize delegation. A ceiling must reference an effective parent
  delegation for that actor, target and action.
- Capabilities, grant effects and create/revoke operations are separately bounded.
  Broad grants cannot override narrower denies. Unknown cross-scope overlap fails
  conservatively; current membership does not imply permanent authority over an
  arbitrary resource or staff identity. Ordinary delegation cannot grant recovery.
- Root review caught array getters being read before validation. Descriptor-first
  validation now rejects those arrays without invoking their getters. Independent
  tests cover stale/foreign parents, scope escalation, revoke-only authority,
  removing denies, self-targeting and deny order independence.
- Combined local regression **02c7d9** passed **86 tests across five files**.
  The implementing agent's TypeScript check **bfaf26** completed successfully.
  Output from the later root TypeScript invocation was lost; it is not counted
  as an independently observed successful check.
- This is not live authorization. Authoritative complete-row loading, persisted
  ceiling records, transactional version checks, last-admin protection and routes
  remain necessary. Revocation must load the actual stored grant rather than
  trust a caller-described scope. No production or PA settings changed.

### September 12: native staff profile and admission lifecycle extension

- Extended the unpublished local 0069 ledger/service to support display-name-only
  `staff.profile.edit` and existing-account `staff.admission.enable`, preserving
  admission disable. Profile edits use profile versions; admission changes use
  admission versions. Enable has its own explicit capability, does not create an
  account, and does not infer authority from legacy profile permission or PA roles.
- Independent review identified that two pending fences for the same mutation
  could otherwise be consumed by one write. Added a unique pending mutation
  identity across action, target and expected/result versions, with a direct
  database regression. No deployed migration was edited or applied.
- Added lifecycle tests for exact/altered replay, separate version domains,
  missing accounts, inactive actor self-enable rejection, late audit rollback for
  both new actions, authority revoked immediately before the batch, accessor
  rejection and concurrent same-version edits. Retained the existing disable
  authorization, audit, replay and concurrency regressions.
- Initial local regression **50fd3e / 31c604** passed 24 tests across three files
  before the independent-review additions. Final regression **33cc3e / 083f70**
  passed **30 tests across five files** in 148.20 seconds, including the real
  directory migration-chain fixture. TypeScript **48df92 / ce8980** exited 0.
  All runners are terminal. This is focused evidence, not a full repository test.
- Dedicated new-action division/legacy-deny matrix coverage still needs expansion;
  the existing disable suite exercises the shared SQL authority predicate, but
  must not be presented as exhaustive lifecycle acceptance. Management routes,
  onboarding, grants/ceilings, recovery and native-auth activation remain pending.
  No production deployment, PA change, retention change or public-link change
  occurred. The broader migration goal remains active and incomplete.

### September 12: pending staff onboarding and identity-preserving audit guards

- Added local migration `0070_native_staff_pending_onboarding.sql` with immutable
  invitation/proposal records, versioned forward-only lifecycle transitions,
  open identity reservations, durable terminal history and exact UTC timestamp
  ordering. It stores invitation digests, not raw invitation secrets, and creates
  no live staff bridge, admission, profile, membership or grant.
- Insert/claim checks reject native and legacy live-identity collisions, including
  a PA-projected bridge created after an invitation. Cancellation/expiration can
  release open reservations without removing the old record. Approval requires
  an exact native identity and matching future onboarding-approval receipt;
  current 0069 cannot issue that receipt, so approval remains unavailable.
- Rejected the first incomplete schema/placeholder test draft and replaced it
  with real 0001–0070 Miniflare fixtures. Root tests verify concurrent reservation
  and subject claims, replacement protection, pending/claimed login isolation,
  retained history, late collision, and rollback of new identity rows when an
  unrelated receipt is presented as onboarding approval.
- Root reproduced a separate 0069 audit guard weakness: mixed identity changes
  could consume a display-edit or enable fence. Focused regression
  **1d8eb8 / ab2ba3** failed both cases as expected. Consume guards now require
  unchanged login email for profile edits and unchanged subject/admitting actor
  for admission transitions. The normal service already wrote only allowed fields.
- Added explicit new-action global/business-area/division/exact-staff coverage,
  target mismatches, old/new denies, invalid parents, legacy-only profile access,
  enable capability isolation and preservation of existing bindings/grants.
  Earlier dedicated scoped-test gaps are now covered locally.
- Intermediate lifecycle regression **113416 / 0ff27d** passed 36 tests across
  five files. Final consolidated regression **c5656d / 2c10ff** passed **48 tests
  across seven files** in 165.65 seconds; final TypeScript **2177a2 / 8be565**
  exited 0. All runners are terminal. These are focused tests, not proof that the
  full repository or production migration is accepted.
- Next implementation: authorized pending create/cancel and isolated claim
  services, then atomic approval with receipt correlation to onboarding ID,
  expected version, proposal and claim evidence. Current SQL state checks do not
  verify a JWT, invitation-secret possession, real-time expiry, scope or ceilings;
  those must be enforced by the trusted command/claim path before routes exist.
  Grant/membership commands, recovery, reviewed bootstrap upgrade, UI and native
  authentication activation remain unfinished. No deployment, PA change, live
  authority, retention change or public-link change occurred; goal remains active.

### September 12: isolated one-time staff invitation claim

- Implemented `native-staff-onboarding-claim.ts` over 0070 pending storage. It
  copies descriptor-safe inputs before asynchronous work, requires exact invited
  email plus a verified opaque subject and sign-in deadline, and compares the
  32-byte invitation digests with a native cryptographic timing-safe comparator.
  The v1 raw secret format is exactly 64 lowercase hex characters. No raw secret
  or JWT is stored, returned or logged by the helper.
- A first-primary conditional UPDATE pins immutable invitation fields, checks
  pending state/version, rechecks invitation and sign-in deadlines using D1 time,
  records immutable claim evidence and returns exact frozen metadata. Existing
  0070 triggers reject late identity collisions. Claims do not create live staff,
  memberships, grants or a PA account; replay/cancelled/expired claims fail closed.
- Independent tests cover changed input after invocation, hostile accessors and
  proxies, concurrent claims, cancellation and identity collisions immediately
  before the actual update, database-time expiry despite an earlier application
  clock, and malformed/lost acknowledgements after a real commit. A missing
  acknowledgement is not interpreted as proof that the invitation remains unused.
- Added an isolated bundled Worker-runtime harness using the configured
  `nodejs_compat` flag, actual crypto imports and D1, proving claim and replay
  behavior inside workerd. Its body-driven synthetic identity is test-only;
  it is not a production authentication route or JWT-verification acceptance.
- Fixed a TypeScript undefined-output check in the new bundle harness. Final
  regression **5ecdfd / c119c8** passed **29 tests across five files** in 99.17
  seconds; TypeScript **0c8574 / a3ee46** exited 0. All runners are terminal.
- Reviewed the remaining generic administrator-ledger mismatch: current 0069
  requires a live-admission target, but invitation create/cancel must precede it.
  Planned explicit live-staff versus pending-onboarding targets without fake
  staff rows or per-action ledgers. Changing SQLite column nullability requires
  a reviewed rebuild/unpublished-schema revision with history/FK/trigger and
  migration-order tests, not a purported simple additive column change.
- Still required: authorized invitation create/cancel, isolated Access claim
  policy and trusted JWT adapter, bounded/rate-limited claim route and UI/status
  experience, atomic independently authorized approval/grants, recovery and the
  coordinated native-auth cutover. Broader PA, client, financial, time and portal
  acceptance remains unfinished. No release, production setting, PA account,
  public link, retention rule or live authority changed; goal remains active.

### September 12: invitation acknowledgement recovery

- Added `readNativeStaffOnboardingClaimStatus`: a first-primary, read-only status
  helper requiring the original secret and trusted verified identity. Claimed
  and approved states additionally require the original opaque subject. It
  returns only frozen onboarding ID/state/version and does not create authority.
  Expired sign-in/invitation deadlines and cancelled/expired records deny reads.
- Independent tests now follow a real lost claim acknowledgement with a status
  read, reject a different subject with the same email, reject cancelled claims
  and database-clock-expired sign-in, and verify unchanged unauthenticated state.
  Input snapshots/accessor rejection and strict malformed-input cases are covered.
  The workerd harness exercises both claim and status; its supplied identity is
  still synthetic, not evidence of a production JWT route.
- Focused run **9efe96 / 0217c9** passed **25 tests across four files** in 78.89
  seconds. TypeScript **2ca41a / ce4acf** exited 0. These runners are terminal.
- The authenticated page/adapter, create/cancel/approval commands and authority
  cutover remain unfinished. An approved status is not current authorization;
  normal staff authentication still checks the active admission independently.
  No production settings, PA instance, public link or retention setting changed.

### September 12: generic staff/onboarding ledger targets

- Implemented local migration `0071_native_staff_management_targets.sql` after
  verifying that a parent-only D1 rebuild fails on retained approval references.
  The two-case synthetic mechanics probe passed (**2dec92**). The real migration
  rebuilds commands, pending onboarding and fences in one batch, explicitly
  copies every original column, and restores the original 16 triggers and four
  indexes. No fake staff identity or separate per-action ledger is introduced.
- Live targets keep concrete admission foreign keys. Pending targets require
  the exact onboarding/proposed-staff pair, with exclusive target shapes. New
  guards freeze target metadata and correlate it between fence and receipt;
  an onboarding partial unique index avoids NULL live-target IDs defeating
  mutation uniqueness. All onboarding administrator commands remain closed.
- Root's real 0001–0071 regression verifies late-error rollback restores the
  original schema and pending record, then verifies every pre-existing staff
  trigger definition after successful upgrade and performs a real claim/status
  read without creating an admission (**067294 / f1dbfb**, one test passed).
  Independent populated-history upgrade evidence (**cc17a3**, one test passed)
  covers real pre-upgrade receipts, claimed history, foreign keys, post-upgrade
  profile/edit/enable operations and current-authorized replay. The final test
  also replays the original receipt and checks immutable history protections.
- The combined eight-file run **af934c / 431f40** reported **32 passed, one
  failed**: a new INSERT OR REPLACE assertion expected an older guard's message,
  but the new target-correlation guard correctly rejected first. Corrected only
  that test expectation and added an exact full receipt before/after comparison;
  production code did not need weakening. Final migration/rollback/admission
  regression **156a5c / 317cb1** passed **six tests across three files** in 65.95
  seconds, including last-administrator protection under 0071. The other seven
  files in the combined run passed; invitation-specific evidence is above.
  Final TypeScript **ef0d65 / a17df6** exited 0; diff check **3c5c0d** passed with
  existing line-ending warnings. All runners are terminal.
- Next: implement the generic authorized invitation create/cancel commands with
  exact prospective/stored scope and proposal checks, followed by independent
  atomic approval and grants. Before opening those actions, replace the old
  live-target-only prestate/receipt/approval predicates with complete onboarding
  checks and evidence correlation; merely removing the closed-target guards
  would be incorrect. Authenticated routes, Access policy, UI, recovery,
  reviewed bootstrap upgrade, broader migration and production acceptance remain.
  No deployment, live data migration, PA change, public-link change or retention
  change occurred. Goal remains active; this is not full-system acceptance.

### September 12: canonical invitation proposals and audited cancellation

- Added the syntax-only version-1 onboarding proposal parser and canonical
  serializer. Memberships and directory/management grants have explicit shapes;
  unsupported authority, extra fields, duplicates, incompatible scope fields,
  accessors and sparse arrays are rejected. Canonical output is a frozen copy,
  sorted deterministically and limited to 8192 UTF-8 bytes. Two suites passed
  eight tests (`0b1d76`), including independent descriptor/mutation/size checks.
  This parser grants no authority and does not replace current parent or ceiling
  validation in creation/approval transactions.
- Added local migration `0072_native_staff_onboarding_cancel.sql` and
  `cancelNativeStaffOnboarding`. It uses the existing generic command ledger,
  verifies the canonical stored proposal/hash, fences pending/claimed versions,
  and rechecks exact current cancellation authority, matching denies and active
  parents. Cancellation preserves claim/history data and creates no staff
  identity. Exact replay remains current-authorized. Create and approve are
  still closed; no new route, Access policy or production migration is enabled.
- Independent review found and fixed a missing database write-fence requirement
  and missing-versus-null claim-evidence ambiguity in audit JSON. Cancellation
  now requires a correlated unconsumed fence before mutation, consumes it once,
  and requires seven distinct result keys with explicit evidence types. The
  three recreated live-staff guards compare exactly with 0071 apart from their
  target-kind wrapper. Existing durability and last-administrator guards remain.
- The first positive local run failed because D1 limits expression trees to
  depth 100. Splitting cancellation allow, deny and parent checks into separate
  triggers preserved those checks and resolved the failure; the focused
  positive suite then passed. Combined runner `42267` completed successfully:
  12 tests across cancellation, independent race/audit boundaries, and existing
  staff-management regression (terminal `3f1326`). TypeScript runner `34337`
  exited 0 (terminal `a90357`). The final distinct-key hardening rerun passed
  all eight cancellation/independent-fence tests (`3f81dc`). All runners are
  terminal. Root read the final service, migration and tests before handoff.
- Next: authorized invitation creation with prospective-scope and delegation
  ceiling checks, then independent atomic approval and live grants, isolated
  authenticated claim routes, recovery, reviewed bootstrap upgrade and UI.
  The broader migration and real dual-instance acceptance remain unfinished.
  No production settings, PA instance, public client links or retention changed.

### September 12: audited pending staff invitation creation

- Added local migration `0073_native_staff_onboarding_create.sql`, the exact-input
  `createNativeStaffOnboarding` service and a cryptographic invitation-secret
  generator. Creation atomically reserves a pending invitation and immutable
  receipt; it does not create a live identity, admission, membership or grant.
  Only secret digests are stored. A future trusted route must retain the original
  secret for retries and deliver it only after confirmed creation.
- Creation checks every prospective membership, current actor/subject, active
  parents, recipient-management authority and exact grant ceilings. Independent
  QA found and closed a multi-membership authority-coupling gap: each membership
  now needs a matching ceiling-backed parent for each grant. Different authorized
  parents may cover different memberships; a matching deny still wins.
- Fixed retry authorization to read durable receipts as well as in-flight fences.
  Migration 0071 consumes a temporary fence after the receipt is inserted; replay
  must not depend on that temporary row surviving. Replay is still read-only and
  current-authorized, including after delegation or ceiling revocation.
- Root compared all ten recreated cancellation triggers against 0072. Their
  bodies are identical after removing the added cancellation-capability filter
  (`aa2584`). No cancellation/history deletion or production migration occurred.
- Final creation suites passed 13 tests (`72faf5`): successful empty, directory
  and management proposals; scoped denials; per-member ceilings; late authority
  revocation; audit rollback; exact retries; and create/claim/cancel without
  admission. Independent input and secret tests also passed in the earlier
  19-test combined run (`05e11e`). Root's final regression passed another 19 tests
  across five files (`54a55b`): existing live-staff commands through 0073,
  historical cancellation/race/audit cases, strict creation input and secret
  generation. Together with the final creation suites, 32 tests passed. Final
  TypeScript check exited 0 (`4a8982`); no test runner remains active.
- Approval and actual admission remain closed. Next are independent atomic
  approval/grant installation, authenticated claim/delivery boundaries, recovery,
  reviewed bootstrap upgrade and management UI, followed by joined migration
  acceptance. This checkpoint does not mark the broader goal complete and does
  not alter PA, public client links, incoming retention or production access.

### September 12: atomic claimed-invitation approval

- Added local `0074_native_staff_onboarding_approve.sql` and
  `approveNativeStaffOnboarding`. The exact command pins the reviewed canonical
  proposal and verified claim evidence at version 2. Only an already-admitted,
  currently authorized administrator other than the claimant can approve; the
  invitation creator may approve a different person.
- The atomic D1 batch creates the protected local staff bridge with its exact
  claimed subject, native admission/profile, and only the proposed memberships
  and directory/management grants. It adds no PA account, owner/pay policy or
  delegation ceilings. Grantors, initial versions, exact scopes and complete row
  counts are checked before consuming the fence. Extra inactive grants fail too.
- The durable receipt triggers the final approved/version-3 transition, with a
  checked one-row update. Late audit, grant or terminal failures roll back all
  live rows and the receipt. The generic fence cleanup remains unchanged. The
  old approval guard's incompatible live-staff target was replaced by exact
  onboarding/proposed-staff and evidence correlation.
- Replay rechecks current approver authority and the target's active admission
  and exact subject; it neither reinstalls grants nor reactivates accounts. Lost
  post-commit acknowledgements recover through the immutable receipt. Existing
  identities are never merged or overwritten by this command.
- A real D1 test exposed expression-depth failure on the shared receipt table.
  Read-only `EXPLAIN` isolated that path (`75b2f3`); separating correlation,
  authority and materialization into independent guards preserved the checks and
  fixed compilation (`a8cde9`). The final tests contain no diagnostic probes or
  dropped guards. Six authorization views match 0073 exactly after the intended
  creation-to-approval capability substitution (`357de8`); approval also enforces
  independent claimant identity.
- Final independent approval/creation regression: **23 tests passed in three
  files**, terminal `4535ad`. TypeScript exited 0 (`1b3550`). The approval tests
  cover nonempty and exact-self proposals, stale evidence, self-approval denial,
  grant revocation, concurrent cancellation, subject collisions, extra inactive
  grants, audit/terminal rollback, lost responses and disable/replay behavior.
  The disable fixture now includes a separate complete surviving administrator;
  the last-administrator guard and acting reviewer's limited ceilings remain.
  A separate final run passed **eight tests in three files** (`3bfdd0`) for basic
  approval, strict input and existing staff commands through 0074. Both final
  runs total **31 passing tests**; all runners are terminal. `git diff --check`
  passed (`50e15f`, existing LF/CRLF warnings only).
- Still open: authenticated isolated claim and delivery routes, invitation
  review/management UI, standalone membership/delegation changes, out-of-band
  recovery, reviewed authority bootstrap upgrade and actual native login.
  Broader PA/API/project/time/financial/client/Incoming/compatibility work and
  coordinated production acceptance remain in M01–M10. No production migration,
  PA release, Access change, public-link change or retention change occurred.

### Native administrator invitation-review UI — local verification

- The isolated `/administration/staff-invitations` screen now uses only the
  default-off native administrator session/review/approve/cancel endpoints.
  It shows exact proposed identities, memberships and allow/deny scopes;
  approval requires claimed evidence, explicit confirmation and a reason.
  Cancellation is separate in the bottom danger zone.
- Private review data clears on session expiry, refresh or invitation changes.
  Uncertain decisions retain their exact command in page memory and allow an
  explicit same-command retry only; no automatic mutation retry or inferred
  success. The command ID is visible for diagnosis without secrets in URLs.
- Final rebuilt assets passed **56 browser tests** across desktop/mobile
  (`8f42d9`), including the existing claimant and Viewer shell. TypeScript
  passed (`f92a25`), build passed (`649d5c`, existing large-chunk warning).
  Both new review screenshots were visually inspected. This is synthetic
  browser evidence, not production authentication or end-to-end acceptance.
- No deployment, PA release, production access/configuration, retention or
  public-link changes. Secure creation/delivery, authority upgrade/recovery,
  normal native login and scoped grant-management workflows remain unfinished;
  the broader migration goal remains active.

### Recoverable native staff invitation issuance — local checkpoint

- Migration 0076 stores an immutable encrypted handoff alongside the existing
  pending invitation and command receipt in one atomic batch. The server
  generates the secret once; retries recover the original secret and recheck
  exact request identity and current creation authority. Creation never grants
  admission and its response contains no invitation secret.
- Separate explicit reveal requires the original native creator, current
  authority and a pending/unexpired invitation. It writes an audit record before
  responding. Claim, cancellation, expiry and revocation prevent handoff.
  AES-GCM uses a dedicated versioned keyring; old keys must remain while their
  pending handoffs need recovery. A missing key fails closed, without replacement
  under the old command ID. No plaintext secrets are saved in D1.
- Exact create/reveal HTTP paths use the existing default-off administrator gate,
  same-origin CSRF, server-derived actor, bounded input and no-store responses.
  Creation accepts up to 16 KiB to accommodate the existing bounded proposal;
  other routes retain the 4 KiB limit. The root dependency does not yet provide
  a handoff keyring, so these two routes remain unavailable even if only the
  existing admin flag is enabled. No production secrets or flags were changed.
- Independent real-D1 tests passed eight cases (`3e298c`); final combined
  regression passed **39 tests / seven files** (`e713b5`), including concurrency,
  exact replay, key rotation, current authority, terminal states and atomic
  rollback. A final typed-stub correction was verified with ten input/HTTP tests
  (`978b23`); TypeScript passed (`a53029`) and build passed (`d925d0`).
- Next: creation/reveal UI and dedicated configuration, end-to-end signed
  native HTTP/D1 acceptance, reviewed administrator bootstrap/recovery and
  normal native staff entry. No email delivery, PA release, production migration,
  public-link change, retention change or goal completion is claimed.

### Native handoff configuration and signed lifecycle acceptance

- Root Worker wiring now supplies the dedicated optional deployment secret
  `NATIVE_STAFF_HANDOFF_KEYRING` as bounded JSON. Only creation/reveal require it;
  malformed/missing material fails closed without breaking session/review paths.
  Existing native flags remain disabled and no live key was installed. The
  parser rejects duplicate JSON members rather than silently choosing the last
  key value, and freezes parsed key material before asynchronous work.
- A real signed synthetic staff request now creates and reveals an invitation
  through the HTTP adapter; a separately signed claimant request claims it;
  another authenticated actor reviews and approves it. All state transitions use
  local D1 through 0076, not mocked command services. Network stubbing is limited
  to the fixture issuer's JWKS response. Exact retry creates no duplicate handoff,
  wrong emails/actors/CSRF/review evidence are denied, and no identity exists
  before approval. Reveal stops after claim.
- Post-approval staff-audience authentication succeeds with the same individual
  subject; claimant-audience authentication remains denied. Newly admitted staff
  with no management grants still cannot invite another employee. This preserves
  the separation between authentication, admission and scoped authorization.
- Final combined regression: **42 tests / eight files passed** (`3fa14d`).
  TypeScript (`9b8d9e`), build (`d4b507`) and generated type verification
  (`8a12ba`) passed. Existing large-bundle/source-map warnings are not new test
  failures. Smaller Sol agents supplied independent configuration QA and the
  signed lifecycle fixture; root reviewed and reran the combined selection.
- Still required: invitation creation/handoff UI with authorized scope selection,
  reviewed bootstrap/recovery, normal native Operations entry and live acceptance,
  plus the remaining customer/project/time/financial/portal migration requirements.
  No production deployment, PA release, public-link or retention changes occurred.

## Client onboarding presentation requirement

Use the existing Project Alpha client onboarding layout and fields as the
Operations baseline, per the owner's explicit follow-up. The source review,
field mapping, small corrections and acceptance checklist are recorded in
[client-onboarding-pa-layout-baseline.md](client-onboarding-pa-layout-baseline.md).
This is separate from native staff invitations. The public form port remains
pending; this requirement does not claim a deployed UI change.

## Native invitation membership selector foundation

- Added an authorized, read-only business-area/division lookup and exact native
  admin `POST /api/native-staff/onboarding/membership-options` route. It filters
  both creation and membership-management allows/denies before bounded results,
  requires active parents and current native identity, and returns friendly
  labels with permanent IDs. No default grants or identity writes occur.
- The endpoint shares the existing disabled feature gate, CSRF/origin/rate/body
  checks and expiry fences. Empty-membership eligibility is not permission to
  assign arbitrary grants. Current create transactions remain authoritative.
- Combined local acceptance: **56 tests / nine files passed** (`71fbe4`), including
  real D1 filtering and the signed invitation lifecycle; TypeScript (`39b919`)
  and build (`17bf6d`) passed. A smaller implementation agent and independent
  read-only reviewer worked on this slice; the parent wired the HTTP route and
  reran combined acceptance.
- Next: authorized grant-scope selectors and invitation creation/handoff UI,
  followed by the already-required recovery/control-plane and live acceptance.
  This does not complete the client onboarding form, the native staff cutover or
  the broader migration. No deployment or PA production change was made.

## Native invitation creation and authorized grant selection

- Added `POST /api/native-staff/onboarding/grant-options`, a read-only native
  route using the existing disabled gate, exact body, same-origin/CSRF, quotas
  and post-read session-expiry checks. It verifies current creation and
  membership authority for every selected membership, then applies current
  grant-management authority and delegation ceilings to each offered scope.
  Allowed grant scopes need not be in the target person's membership area;
  actual authority, not an invented same-area restriction, determines the list.
- The isolated `/administration/staff-invitations/new` screen now selects
  authorized memberships and grants explicitly, creates a pending invitation,
  and reveals its secret only through a separate current-authorized action.
  It does not activate staff or send an email. Unknown create outcomes retain
  the exact command and proposal for explicit retry. Edits reset confirmation;
  session refresh/expiry removes sensitive choices and revealed secrets.
- Fixed UI protocol mismatches found during parent review: supported lists can
  contain 256 memberships or 258 grant scopes, with a bounded 1 MiB response
  reader; proposed-person grants retain their exact staff ID. Directory division
  grants serialize with null area, while staff-management division grants keep
  their area. Resources and existing-person searches remain pending, not silently
  replaced by raw-ID entry or broad grants.
- Current local evidence: **33 tests / four files** passed (`6c2439`), including
  real D1 option filtering and signed-JWT HTTP-to-D1 lookup/lifecycle acceptance.
  **76 desktop/mobile browser tests / four files** passed (`c28a1a`), covering
  creation/review/claim plus the existing Viewer shell. Parent viewed both form
  screenshots; no horizontal overflow or overlapping fields. TypeScript passed
  (`0f70a5`); build passed (`b8c7fd`) with existing bundle/source-map warnings.
  Smaller Sol agents implemented the picker/UI and independently inspected HTTP
  guards; parent integrated, corrected and ran acceptance.
- Next: resource/existing-person scope selection and complete staff-management
  workflows, reviewed control-plane upgrade and recovery rehearsal, then native
  entry/cutover acceptance. PA-style **client** onboarding remains a separate
  pending implementation, alongside customer/project/time/finance/portal work.
  Nothing was deployed; native gates remain disabled. No PA, public-link,
  Incoming retention or TrueNAS configuration was changed in this slice.

## PA-style client onboarding form port

- Implemented the reusable native client form and shared validated field snapshot
  using PA's current form source and the recorded layout baseline. Preserved the
  personal/company contact separation, conditional organization fields, address
  order, radio selector and submit-for-review experience. No production route or
  PA endpoint was mounted. This is separate from staff invitations.
- Local acceptance: seven parser tests (`277f82`), eight desktop/mobile component
  browser tests (`d3464a`), and TypeScript (`22b1b8`) passed; parent visually
  inspected both responsive screenshots. A smaller agent implemented the form;
  parent supplied the shared contract, fixture tests and isolated box-sizing fix.
- Next client-onboarding work: Operations invitation/submission/review ledger,
  current-authorized create-admission issuance, and explicit client/organization
  relationship/approval consistency. Existing directory store handles one record
  per mutation and cannot yet prove atomic company-plus-contact approval. Its
  two-character client state contract must be reconciled with PA's full-name
  form input. Preserve submitted data in review rather than silently truncating
  it or matching/merging by name/email. See the baseline document for details.
- No deployment, production invitation, directory write, PA change, public-link
  change or broader goal completion is claimed by this component checkpoint.

## Client onboarding submission persistence checkpoint

- Added local migration 0077 and an immutable proposed-data submission service.
  An invitation secret permits submission only, not directory creation or access.
  Exact retries return the same receipt; expiry, revocation, changed data and
  conflicting IDs fail closed. Transactional state transition and explicit
  replacement-insert guards protect submission history.
- Smaller Sol agents implemented the ledger and independently reviewed it.
  Review found and corrected replacement-insert, trailing-newline validation,
  and input reread issues. The isolated eight-test D1 suite passed (`87c74d`),
  and final TypeScript checking passed (`6750eb`). Expanded form lifecycle and
  responsive browser coverage passed all 14 tests (`65b06b`).
- The full migration-chain regression now includes 0077 and verifies the new
  tables do not implicitly issue invitations or admit staff. Joined submission,
  parser and migration-chain execution passed all 18 tests across three files
  (`36be63`, 81.48 seconds), including the real 0001–0077 migration chain.
- Before public mounting, implement trusted invitation scope context, authorized
  issuance and review, canonical contact/organization relationships and atomic
  approval, bounded HTTP transport and operational notification deduplication.
  The PA client-state schema/API mismatch remains a release gate. See
  `client-onboarding-native-contract.md` for the concrete integration contract.
- No production configuration, PA source, existing public link, retention policy
  or deployment changed. The overall migration remains active and unfinished.

## Client onboarding exact-retry and issuer-policy follow-up

- Implemented an in-memory submission attempt controller, with pinned immutable
  fields/UUID, exact receipt/hash validation, explicit retry after unknown
  transport outcome and invalidation fencing before/after transport. A smaller
  Sol agent implemented it; parent inspected and added a real D1 lost-response
  bridge regression. All 25 controller/parser/submission tests passed (`8e6ffb`);
  TypeScript passed (`f768d8`). No public route or UI adapter is mounted yet.
- The read-only authority review identified a missing boundary: canonical create
  fences consume an already-trusted admission; they do not authorize issuing
  one with arbitrary extra scopes. New invitation/admission issuance must cover
  each proposed business-area/division scope and honor all matching denies.
  Existing-client operations instead use the full D1-derived record context and
  existing edit policy. Do not substitute PA API scopes for native staff grants.
- Next: trusted multi-scope invitation issuance and issuer revocation checks,
  then authorized review/canonical approval and the rendered form/HTTP adapter.
  Preserve exact retry across uncertain outcomes, and implement authorized
  reload recovery rather than storing bearer credentials in browser storage.
  Details are in `client-onboarding-native-contract.md`; no deployment or overall
  completion is claimed.

## Client onboarding rendered recovery and issuance policy

- Connected the in-memory attempt controller to the PA-style form through
  `ClientOnboardingSubmission.tsx`. Uncertain responses keep original fields
  locked and show a prominent same-command retry; only exact validated receipts
  show confirmation. Changing invitation IDs clears prior client details.
  Disablement, changed context and expiry invalidate the attempt; deadlines are
  rechecked immediately after asynchronous responses as well as on a timer.
- Added pure new-client issuance policy requiring native identity, active scope
  parents, an allow covering every proposed scope, and no matching deny. Existing
  targets are deliberately excluded: they need the complete current D1 record
  context. Pure policy is not a transactional authorization fence.
- Verification: all 23 policy/controller/parser tests passed (`f917ea`); all 24
  desktop/mobile form, lifecycle and submission-adapter tests passed (`a994a0`).
  Parent inspected the mobile retry screenshot and moved recovery above the
  form with plain language and a full-width button. Smaller Sol agents supplied
  bounded policy/UI work; parent supplied browser fixtures and integration QA.
- Remaining before launch: actual authorized issuance and immutable scopes,
  issuer-revocation checks at submission, review/canonical approval, notification
  deduplication, bounded HTTP transport and authorized reload recovery. No
  production routes, PA changes, deployment or existing public links changed.

## Client onboarding database issuance and revocation acceptance

- Added migration 0078 and the internal invitation issuer. Persisted authority
  binds exact native staff subject/admission/profile versions; new-client scopes
  require authorization for every proposed scope, while existing clients use
  their complete current database scope context and all matching denies.
- Connected submission writes and exact receipt recovery to live issuance
  authority, including a database insert guard. Revocation preserves evidence
  but blocks further client use; re-admission does not revive old invitations.
- Joined local issuance/submission/policy/full-chain tests: 28 passed (`65e344`);
  TypeScript passed (`533689`). StrictMode rendered submission and secret-change
  tests: 12 desktop/mobile cases passed (`759f02`).
- Next: protected invitation handoff and public HTTP flow, authorized prefill,
  review/canonical organization-contact approval, and deduplicated notification.
  Unknown acknowledgement must recover the same issuance command, not assume
  rollback. PA address-contract compatibility remains an owner-reviewed gate.
  This checkpoint is not a deployed onboarding link or completed migration.

## Client onboarding HTTP transport acceptance

- Added the unmounted public session/submit/status HTTP adapter and matching
  browser transport. Client requests use a bearer rather than staff identity;
  responses contain only invitation state/expiry or the exact submission receipt.
  No existing-client PII prefill is disclosed without recipient verification.
- Browser transport refuses redirects, omits cookies/referrer, bounds response
  bytes and elapsed time, and delegates exact retries to the existing controller.
  Worker checks current issuance authority, origin, bounded JSON and keyed quota
  callbacks; post-write uncertainty is not reported as definite rollback.
- Browser/controller tests: 18 passed (`754940`). Real D1 HTTP tests: 10 passed
  (`beead6`), including browser-to-handler-to-database lost-response recovery,
  expired/unbacked invitations and current issuer grant revocation.
- Remaining launch gates: durable client-specific quota implementation,
  protected staff creation/reveal, recipient-verified prefill, page/reload flow,
  scoped review and canonical approval, notification deduplication, then route
  mounting and browser acceptance. No production routes or old public links
  changed; no PA deployment occurred.

## Client onboarding page and persistent quota checkpoint

- Added `ClientOnboardingPage` with a once-before-render fragment bootstrap,
  PA-style form connection, validated pending/submitted session handling and
  explicit original-link reopen recovery. The cleaned URL stores no invitation
  in browser persistence; reload asks for the original link. No PII is returned
  merely to prefill an existing customer's invitation.
- Added migration 0079 and dedicated atomic D1 quota counters, with a bounded
  expired-counter cleanup. This is separate from staff quota keys/tables and
  does not alter incoming-object retention or schedules.
- Eight desktop/mobile page tests passed (`8e5415`); parent inspected both
  screenshots. Joined real-D1 HTTP/quota/full 0001–0079 chain: 20 tests passed
  (`23c62e`). Final TypeScript check passed (`f23fea`).
- Next: protected client invitation creation/reveal with recoverable encrypted
  handoff and audit, then recipient-verified prefill and scoped staff review /
  canonical approval with notification deduplication. Production route mounting,
  quota binding and counter-cleanup scheduling remain explicit release work.
  No existing public links, PA instances or production routes changed.
# Onboarding route acceptance and remaining end-state work — September 12

- Trusted API connection JSON now flows from the Worker's deployment secret to
  enrollment discovery and the decision service as a captured third argument,
  never as browser intent. Existing generated platform bindings are unchanged;
  application secret typing documents this optional secret. Local HTTP/routing
  tests passed 29/29 (`15ad4e`), including actual Worker secret composition.
- Decision-time validation now rejects new nonempty destinations unless their
  exact source/application/instance/epoch/origin matches the captured deployment
  configuration. Exact committed replay is checked first and still requires
  current staff authority. Nine real-D1 tests passed (`231baa`), including zero
  writes for mismatches and successful replay after configuration rotation.
  Browser enrollment selection and runtime outbox delivery are still required.
- Enrollment-choice HTTP adapter is now implemented with a trusted configuration
  dependency captured before awaits. Its exact request excludes configuration;
  versioned native authentication, CSRF and bounded body parsing remain required.
  HTTP/routing tests pass 28/28 (`77cad5`), including dependency mutation after
  capture and rejection of browser-injected configuration. Worker environment
  composition, browser choices and approval dependency wiring remain pending.
- Staff queue component tests passed desktop/mobile 8/8 (`edc71b`) after scoped
  border-box sizing corrected overflow and button interception. This is local
  synthetic acceptance, not a deployment or production-data test.
- Native staff queue now mounts at `/clients/onboarding/invitations`, with a
  stable transport, lazy entrypoint and query/fragment removal. The invitation
  receipt links to it. Fresh build passed (`1b1520`); six desktop/mobile actual
  queue/review route tests passed (`8941d9`), including authorized minimal-row
  display, review navigation, and denied/expired session behavior. Dedicated
  queue component lifecycle tests remain under execution.
- Enrollment-choice coherent authority fixes are complete locally: profile.view
  and enrollment.manage rechecked together across every scope, with no legacy
  registry lookup. Three D1 tests passed (`86bd5e`), TypeScript `61514d`.
  Decision-time exact-configuration validation is now being implemented after
  the committed-replay branch so configuration rotation cannot hide a prior
  successful decision. Browser selection wiring and runtime delivery remain.
- Queue browser transport is implemented on the fixed same-origin staff route,
  with exact cursor requests, a 64 KiB response cap, at most 50 sorted unique
  entries, canonical timestamps and minimal immutable fields. Its five new
  tests plus five existing review-choice transport tests pass (`1c6cf4`). This
  is transport acceptance, not staff queue-screen or production acceptance.
- Submitted-review discovery now has an exact POST `review-queue` staff adapter:
  versioned native authority, CSRF/origin/rate checks, 4 KiB request bound, no
  handoff key requirement and a post-read authorization deadline check. HTTP and
  existing Worker namespace tests passed 27/27 (`4332bf`); queue adapter tests
  mock its service, so real-D1 authorization and browser queue wiring remain
  separate required checks. No invitation secret is returned by discovery.
- Additional actual-route browser regressions verify denied and already-expired
  native sessions on desktop/mobile: 4/4 passed (`d8371c`) against the local
  `ebe048` bundle. These do not cover later unbuilt review-panel edits.
- Enrollment-choice discovery is now an assigned implementation slice: use exact
  invitation/current admission and all-scope enrollment authority, returning only
  eligible source/application/epoch choices without credentials. No automatic
  choice or enrollment; existing destination policy remains server-owned.
- Local native staff review route and invitation receipt navigation are mounted.
  Fresh production-format local build passed (`ebe048`); desktop/mobile actual
  entrypoint browser tests passed 8/8 (`5f74e3`). They verify receipt navigation,
  URL cleanup, denied native authentication and no legacy authority fallback.
  An earlier 4/8 run used stale `dist/client`; it was not current-source evidence.
- These route tests do not prove successful browser approval or recovery. The
  review panel's session-expiry, uncertain-save recovery, explicit confirmation
  and organization-search corrections remain under active implementation/QA.
- Independent end-state review confirms these required next slices, not optional
  future enhancements: authorized PA destination enrollment choices (new-record
  browser commands currently use empty destinations); bounded runtime directory
  materialization, dispatch and acknowledgment reconciliation; and an authorized
  submitted-invitation queue with deduplicated operational notifications.
- PA address-contract compatibility and authorized recipient prefilling remain
  release gates. Native-only approval is not evidence of PA synchronization or
  complete client onboarding. No production cutover or PA deployment occurred.

## Local Client duplicate-0199 Wrangler checkpoint — September 13

- The original locked Client Wrangler 4.118.0 passed `SELECT 1` (`6db5dc`),
  discovered all 132 pending Client migrations including both distinct 0199
  filenames (`e8686d`), and applied the full chain through 0213 (`bf9302`) on
  a fresh short workspace-local persist path. Its D1 ledger has 132 applied,
  distinct names, exactly one each of `0199_incoming_upload_pickup_lifecycle.sql`
  and `0199_native_viewer_grants.sql`, and one final 0213 (`30cd19`).
  `PRAGMA foreign_key_check` returned no rows (`9fc588`); schema counts are
  269 tables, 274 indexes, 421 triggers and three views (`f095e0`); a repeat
  Wrangler list reported no pending migrations (`e392b4`). This is synthetic
  local migration acceptance, not existing-data or production acceptance.
- An isolated exact Wrangler 4.116.0 candidate with Miniflare 4.20260730.0
  independently passed the same short-path full chain: 132 distinct ledger
  rows, each 0199 once, empty foreign-key check, matching schema counts and no
  pending migrations (`dc1ba0`, `ac0650`, `03f8b9`, `2354a6`, `d450d5`). The
  Client, Operations and ops-sync manifests/lockfiles remain unchanged at
  Wrangler 4.118.0 with its nested Miniflare 5 alpha. A downgrade is not needed
  for this local D1 migration check.
- Both versions previously failed even `SELECT 1` with `SQLITE_CANTOPEN` under
  longer default workspace persist paths, including an approved retry. The
  installed storage layout projects a 64-hex-character object ID plus `.sqlite`
  under `miniflare-D1DatabaseObject`: the old candidate path reaches 265
  characters, versus 205 with its short persist path (210 for current Wrangler).
  Both versions succeeded after changing only to fresh short persist paths,
  strongly supporting a Windows path-length cause; workerd's original error
  did not name the failing file. Nonfatal Wrangler user-profile log-write
  `EPERM` messages can still appear in the sandbox despite successful SQL.
- Repeat locally only with an isolated synthetic Wrangler config containing a
  dummy D1 ID, `client-local-smoke` database name, `DB` binding and
  `migrations_dir` pointing at `apps/client/migrations`. Use the existing
  installed Client CLI and a fresh short path inside this workspace; never omit
  `--local` or substitute the
  production Wrangler config:

  ```powershell
  $cli = '<Goal-Completion>/apps/client/node_modules/.bin/wrangler.cmd'
  $config = '<Goal-Completion>/tmp/<isolated-test>/wrangler-local.jsonc'
  $persist = '<Goal-Completion>/tmp/d1-<short-unique-id>'
  & $cli d1 execute client-local-smoke --local --config $config --persist-to $persist --command 'SELECT 1 AS ok'
  & $cli d1 migrations list client-local-smoke --local --config $config --persist-to $persist
  & $cli d1 migrations apply client-local-smoke --local --config $config --persist-to $persist
  ```

  Check `d1_migrations` for both full 0199 names as distinct rows, then run
  `PRAGMA foreign_key_check` and list again for no pending migrations. The two
  short-path local states and the 4.116.0 isolated candidate are retained for
  review; no remote D1, deployment, credential or production action occurred.
  Pin both 0199 filenames and 0210–0213 in the staged migration inventory.
  Populated old-data and existing-public-link compatibility remain separate
  release gates.

### Native monitor route mount and release guard — September 13

- Permission administration requirements are now recorded in
  `native-integration-grant-management.md`. A dedicated management authority must
  be explicitly established; existing PA ownership, ordinary staff management
  and historical bootstrap approvals are not upgraded implicitly. The bounded
  pure command policy is being implemented separately from future atomic D1
  execution. An inactive target's existing grant can still be revoked. No
  administrator bootstrap or grant issuance has occurred.

- Operator UI follow-through: `/administration/connections/monitor` now uses a
  native-only wrapper, linked from Administration with a return link. Root
  TypeScript passed (`ba7b46`); Ops build passed (`01f523`), and all six built-page
  desktop/mobile cases passed (`d17bc9`). The earlier isolated panel suite passed
  16 cases (`dd3c43`). No API call occurs before explicit reload and denial never
  falls back to legacy PA authentication. These are local synthetic checks.
- Scheduler revision dependency is replaced with current audited-head selection
  against the complete deployment identity set; one pre-await configuration
  snapshot is reused through execution. Expanded browser transport10 and real-D1
  selector3 passed in `45cee3`; mocked schedule6 passed after fixture correction
  in `5c831b`. Explicit integration-grant administration and uncertain-email
  reconciliation still block activation; all production flags remain unchanged.

- Mounted the reserved monitor namespace before legacy PA staff authentication.
  Supported session/read/control requests use the native boundary; unknown
  descendants and methods stop with 404. The dedicated enable flag remains false
  and origin blank. No authority is seeded and server connection configuration
  is not accepted from the browser.
- Luna reports all 15 focused routing/HTTP cases passing after the exact local
  test command received sandbox approval. These are mocked routing/HTTP tests,
  not live Cloudflare or PA acceptance; prior real-D1 store evidence is separate.
- Root added the control flag to the dormant mutation release-profile checks.
  All 20 Node tests passed (`592ed0`), covering all four existing release profiles
  and rejecting missing, malformed or enabled control settings. The full migration
  release remains unfinalized; no deployment or production activation occurred.
- Next: implement explicit native grant administration and the operator-facing
  state/recovery flow, including uncertain-mail reconciliation. Continue broader
  onboarding, projects, workforce and cutover acceptance; this checkpoint does
  not satisfy those requirements or change the owner's PA release boundary.

### Integration grant executor review — September 13

- Migration 0092 and the native-only command executor are now local. The first
  full-chain D1 run passed four cases (`11b4b6`), and TypeScript passed
  (`2efa03`), as reported by the implementation agent. This preliminary suite
  proves basic create/replay/revoke, no seeded authority, audit-failure rollback
  and lost-acknowledgement handling; it does not establish race safety.
- Root review identified a missing transactional before-state check: a racing
  grant update could reach the requested after-state while the executor's own
  update affected no row. A matching after-state must not permit a new receipt
  falsely attributing that mutation. Corrections and between-read-and-commit
  regression cases are required before accepting this path.
- Replay also needs canonical finite deadline validation and a consistent
  current-authority read. Exact review gates are recorded in
  `native-integration-grant-management.md`. The implementation remains unmounted
  and no permission, bootstrap or production flag has changed.
- Staging migration inventory reconciliation is in progress independently.
  Listing the new migrations does not finalize their contents or certify a
  coordinated release. Retain `RELEASE_CONTRACT_FINALIZED=false` and the owner's
  PA deployment/production acceptance gate.

### Staging inventory reconciliation verified — September 13

- Added all 44 previously omitted post-boundary migration names: Operations
  0054–0092 and Client's separate `0199_native_viewer_grants.sql` plus 0210–0213.
  Both full 0199 filenames remain distinct. The synthetic release-evidence
  example now matches the explicit inventory, without adding successful live
  observations or changing its pending readiness fields.
- Root expanded verification beyond the agent's 17 passing preflight tests.
  The joined staging preflight/evidence/acceptance run initially passed 56 of
  58 cases (`53d54f`); the two failures were obsolete evidence-test suffixes
  still ending at Operations 0053 and Client 0209. Root updated those exact
  expectations, retained all historical entries, and checks every listed
  Operations migration exists. All 58 cases now pass (`779fc6`, exit 0).
- This verifies inventory and release-guard consistency, not migration content
  acceptance, a staging deployment, or production readiness. Migration 0092
  remains under executor QA. Immutable release candidates/checksums, populated
  rollback rehearsal, live workflows and owner PA acceptance remain required.
  `RELEASE_CONTRACT_FINALIZED` stays false; existing public links are unchanged.

### Default-off workforce issuer route and release guard — September 13

- A disjoint native grant-issuance-only HTTP route now intercepts before the
  legacy Project Alpha staff middleware. It requires current native Access
  identity and admission, same-origin and purpose-bound CSRF, bounded JSON,
  IP/subject rate limits, and server-supplied actor identity. No manager or
  issuer authority is seeded. The route flag remains `false` and its origin
  blank; no deployment occurred.
- Root restored locally displaced package-manager dependencies without
  overwriting existing packages, regenerated Operations Worker types from
  Wrangler, and added an exact router-dispatch regression. Focused HTTP/router
  tests passed 8/8; Operations TypeScript and type-generation checks passed.
  Independent QA found no confirmed auth/CSRF bypass, but these tests do not
  replace full D1 authority and controlled-race acceptance.
- The portal release profile and staging preflight now require the workforce
  issuer route to remain disabled with an empty origin. The checked-in staging
  config and synthetic evidence example match that guard; the combined
  release-profile, preflight, evidence and acceptance suites passed 82/82.
  This is local release-contract consistency, not readiness or production
  acceptance. Keep `RELEASE_CONTRACT_FINALIZED=false` and the owner PA gate.

### Integration grant zero-CAS correction — September 13

- The unmounted 0092 native integration-grant executor now treats a zero-row
  create/update as an aborted command batch, not proof from a matching desired
  after-state. The receipt trigger checks the immediately preceding mutation
  count; a failed CAS rolls back its immutable fence. Controlled stale-create,
  stale-update and direct rollback tests pass individually. Canonical finite
  verification deadlines and a current-authority replay check also pass
  focused tests. The complete local D1 executor suite subsequently passed
  16/16 tests (395 seconds), including stale-write and rollback cases.
  Separate management bootstrap and controlled release acceptance remain
  required before activation; no grant was seeded or deployed.

### Native workforce issuer authority-race checkpoint — September 13

- Four controlled real-D1 interleavings now mutate the selected manager,
  issuer ceiling, issuing actor admission, or target admission after preflight
  and before grant issuance commits. The complete issuance test file passed
  7/7. Every stale-authority attempt is denied and leaves no grant, issuer
  proof, or receipt; no SQL or executor relaxation was needed.
- These tests strengthen commit-time authorization evidence, but do not seed
  an issuer, enable the default-off HTTP route, establish governed successor
  recovery, or prove live PA/Ops cutover. The owner PA deployment and combined
  production acceptance gates remain intact.

### Existing-directory acquisition checkpoint — September 14

- The local PA candidate has exact-scoped, default-off readiness,
  initialization, current-read, and existing-record binding routes. Repeated
  focused front-controller/readiness tests pass **11/11, 113 assertions** with
  PHPUnit's optional result cache disabled. A disposable HTTP/MySQL route
  rehearsal is prepared but did not run without the isolated database sentinel;
  this focused result is not joined acceptance or release evidence.
- Operations has isolated, unwired readiness/initialization and binding
  transports. The binding adapter's focused unit selection passed **7/7** in
  the implementing agent's run; the Operations TypeScript check passes. Their
  content validation does not establish a reviewed customer match, durable
  link, current remote revision, or authorization to send a write.
- The next gate is exact, operator-selected existing-customer verification and
  reviewed binding evidence. Names and emails are not link keys. `READY` needs
  explicit initialization; `RECONCILIATION_REQUIRED`, mismatched revisions,
  missing authorization, and uncertain transport responses stop acquisition.
  A historical initialization or binding replay is followed by a fresh
  authorized read before any materialization. No production connection,
  credential, route flag, retention setting, or public link changed here.
- An isolated read-only candidate verifier now passes four focused unit tests.
  It returns no customer profile and makes no write call. Migration 0111 and
  an immutable review-only D1 evidence store pass five focused cases; the
  current combined route, verifier, store and existing migration-chain selection
  passes **50/50** tests; Operations TypeScript passes. A native staff POST
  verification route exists behind a default-off flag. It requires a selected
  local record, exact enrolled destination, current view/edit/identity-link
  grants, CSRF and same-origin admission, and rechecks authority after the PA
  response. It is read-only, returns bounded evidence and is not enabled or
  wired to the materializer. Reviewer-attested identity is not yet an actual
  PA binding receipt or current authorization proof.
- Migration 0112 adds an isolated, retry-stable acquisition reservation and
  append-only state events, pinned to an exact 0111 review receipt. Focused D1
  tests pass **5/5**; the combined focused selection passes **55/55**. The
  initial global uniqueness draft was corrected:
  one Operations customer can be linked independently to LTDS and LTT, and
  a newer-revision re-review of the same exact pair can reserve a new command.
  Partial identity retargets within one PA namespace fail closed. No route,
  PA call, current-state reconciliation or materializer authority is wired;
  ledger acknowledgement alone cannot be treated as a PA binding. A mistaken
  immutable review still requires an explicit correction/supersession path;
  no reviewer-error recovery is active yet.
- A new disposable full Operations migration-chain test applies 0001–0112
  around a populated historical canonical client and verifies unchanged
  record, revision, audit and intent rows (1/1 passed). This tests local schema
  compatibility; it is not a remote D1 backup, restore or live cutover proof.
- Client Hub onboarding-review navigation remains deliberately undiscoverable
  for now. Its existing direct routes are intact, but neither a successful
  native-staff session nor an empty review-queue response proves review scope:
  the queue may be empty because there are no submissions **or** because no
  submission is within the staff member's per-record grants. Before adding a
  tab, expose a separate server-derived `canCreate`/`canReview` capability
  under the rollout flag, using the same admission and grant policy as the
  actions; every detail/decision route must still recheck per-record authority.
- PA's local generic directory initialization replay now revalidates the
  locked current profile hash, state presence and receipt revision. A stale
  P1 receipt after a legitimate P2 edit returns `409 RECONCILIATION_REQUIRED`
  instead of a current-looking success. Root reran the three focused PA
  service/HTTP suites: **30 tests / 209 assertions passed**. This local fix
  is not deployed to staging or either production PA instance. Root then ran
  the full current local PA PHPUnit suite: **1,236 tests / 9,134 assertions /
  96 skipped**, exit 0. The skipped tests remain unverified, and this local
  result is not staging or production acceptance.
- The supplied staging LAN control API and public tunnel did not answer
  read-only shell probes from this workspace. The public tunnel did open in
  the signed-in in-app browser: staging showed version `v59e8644` and an empty
  staff onboarding invitation list. This is a browser reachability check, not
  evidence that the local PA candidate is deployed. Candidate deployment,
  populated rehearsal, two-instance cutover, and owner PA deployment remain
  open.

### September 14 Incoming regression and acquisition follow-up

- Root reran the current local Incoming publisher/outbox/read/staff-route
  selection after the PA replay correction: **4 files / 41 tests passed**.
  This protects the `ready/` pickup code path in fixtures, but it is not proof
  of a particular TrueNAS hourly pickup, email delivery, or live object state.
- Root reran five Client public-share/migration/single-file/ZIP suites:
  **33/33 tests passed**. These cover selected local legacy-password,
  expiration, revocation and download paths; they do not prove every live
  pre-existing public link or a 30 GB download after the future authority
  cutover. Keep the live-link acceptance inventory open.
- The API-first existing-record acquisition is still incomplete: candidate
  verification, immutable human-review evidence and command reservation alone
  must not be mistaken for a usable PA binding or canonical mapping. Work now
  targets an executor with exact retries and a fresh authorized PA read; route
  exposure remains default-off pending independent review and end-to-end tests.
- A default-off native candidate comparison route now returns bounded local
  and PA profiles for an already-initialized, revision-matched selected record.
  It requires current native admission, same-origin/CSRF/rate checks,
  record-scoped view/edit/identity-link/enrollment-management grants and an
  active global enrollment-management grant. It uses only the enrolled PA
  destination and neither binds nor records review evidence. `READY` remains
  an explicit initialization prerequisite. Root reran its focused tests along
  with the acquisition tests below; this is not a finished reviewer UI.
- An internal acquisition coordinator now checks exact 0111/0112 identity on
  every invocation, fresh PA profile/revision and injected current reviewer
  proof before first immutable reservation. It retains the exact command after
  uncertain sends, uses numeric 0112 state versions, and does not append a
  forbidden second `uncertain` event. QA found and the implementer corrected
  three ledger/proof mismatches plus reservation-before-authority ordering.
  Even after a PA acknowledgement it returns `proof_required`, not a mapping:
  PA binding-current proof, an operator review submission, canonical outbox
  integration and route admission remain open. Root's combined local selection
  passed **4 files / 45 tests**, including disposable D1 cases; Operations
  TypeScript passed. No feature flag was enabled or production PA called.
- The preview's extra global enrollment-management gate was checked against
  disposable D1 rather than mocks alone: the native authorization suite now
  passes **17/17**, including resource-only denial, global allow and global
  deny precedence. This does not replace a full joined HTTP acceptance test.
- PA's generic directory and project bind replay now rechecks the current
  exact external-to-PA binding row inside the command transaction; missing or
  retargeted rows fail instead of replaying a stale success. Root reran the two
  focused PA suites: **15 tests / 131 assertions passed**. The schema still
  allows local binding-row mutation, so a separate authorized binding-status
  read remains needed for robust Ops reconciliation beyond original-command
  replay. Root then reran the full current local PA PHPUnit suite after this
  correction: **1,239 tests / 9,154 assertions / 96 skipped**, exit 0. This
  local PA change is not deployed or owner-approved for release.
- A separate generic PA v2 binding-status GET now has local client,
  organization, and project implementations and exact per-resource read scopes.
  It returns only current binding identity/revision after application,
  source/epoch, current grant, linked authority, and projection-state checks.
  Its capability advertisement was corrected to use three distinct concrete
  paths, matching the strict Operations preflight. PA's full local suite now
  passes **1,244 tests / 9,173 assertions / 96 skipped**. The endpoint flag
  remains off in deployments, and the PA owner has not reviewed a release.
- Operations now has a read-only, bounded transport client for that status
  endpoint, but it is not yet wired to the acquisition coordinator or mapping
  path. Combined local native-directory route, D1 review, and transport tests
  passed **4 files / 39 tests** after independent review and correction of a
  malformed-proof case: resource revision `0` is now rejected. TypeScript
  passed. This is still a local transport contract, not a proven live binding.
- The default-off human review-attestation route persists only 0111 evidence
  after explicit confirmation and fresh PA/local checks. Independent QA found
  and corrected a caller-supplied external ID and caller-supplied audit time:
  the ID is now derived from the enrolled canonical destination, and the
  review time is server-authored with retry-stable hashing. A single conditional
  D1 `INSERT ... SELECT` now fences the exact local record/version, enrolled
  destination, staff admission/profile, effective record grants and global
  enrollment grant at write time. A same-hash lost-ack retry uses that same
  predicate before returning the prior receipt; stale/revoked state fails.
  Disposable D1 interleaving tests cover revision, enrollment, grant revoke,
  deny, and unchanged authorized replay. Root reran the route plus 0111 D1
  suites: **2 files / 33 tests passed**, and TypeScript passed; independent QA
  found no remaining local replay/fence issue. **Do not enable this route yet:**
  there is no finished reviewer UI or end-to-end PA binding/mapping path, and
  a remote PA observation can never be atomic with the D1 write. The later
  executor must keep its fresh PA read and binding-status proof. No PA write,
  mapping, public link, or production flag was changed by these local steps.

### September 14 — durable acquisition receipt and provenance boundary

- The existing-record flow now has a strict PA v2 acquisition-response receipt
  in additive migration 0114. The Worker transport validates the bounded PA
  response against the exact command and namespace; the coordinator persists
  that receipt before acknowledging 0112, and retries an uncertain PA command
  with its original idempotency identity. An internal proof adapter then
  re-reads PA profile and binding status and requires a current reviewer
  callback before storing an inert 0113 acquired-mapping receipt. Neither
  receipt is a canonical mapping or portal grant.
- The candidate review panel has an exact same-tab recording-status lookup
  and immutable preview identity across asynchronous requests. Local
  verification after the latest rollback: **seven focused Operations suites,
  46 tests passed**, six desktop/mobile browser tests passed, TypeScript check
  and production build passed. The disposable migration chain through 0114
  preserves populated canonical history. None of these checks is live staging
  or two-instance production acceptance.
- Independent QA rejected a proposed 0115 SQL promotion marker. A writer with
  D1 access could copy the stored response hash and insert it without fresh PA
  or reviewer checks. The marker/migration were removed; no 0082, materializer,
  project, portal, or public-link reader was activated. Treat arbitrary D1
  writes as privileged control-plane authority; restrict and audit that access
  rather than claiming SQL proves the Worker caller. The next mapping design
  needs a controlled Worker promotion path, exact current PA checks, ownership
  epoch and uniqueness fences, and coherent legacy/acquired reader updates.
  Do not synthesize a legacy 0054 outbox acknowledgement.
- A follow-up review found two additional proof gaps before promotion. The
  0113 adapter now rechecks the reviewer-observed PA profile hash through a
  fresh generic readiness/current-read verification and fails closed on a
  changed hash or unavailable PA. A **different**, additive 0115 migration
  now stores the local record version at fenced review time, leaves prior/raw
  reviews NULL, and requires the same current version at a new 0113 insert.
  The adapter rejects missing/stale local versions before PA calls, and the
  SQL trigger closes the local read-to-write race. A second strict PA
  candidate check after the profile and binding reads closes the observed
  same-revision profile-hash interleaving; independent QA re-reviewed that
  fix. PA can still change after the final remote read but before D1 commit;
  the eventual live consumer needs an explicit
  freshness policy, not a permanently-current interpretation of the receipt.
  A server-only current-reviewer callback factory now rechecks the original
  reviewer's admission/profile versions, effective record action grants,
  global enrollment authority, local revision, and exact PA enrollment
  namespace. It is unmounted and changes no canonical mapping or client link.
  The combined local suite now passes **ten files / 64 tests**, including
  independently reset denial cases. Operations TypeScript and the production
  build pass locally; independent QA found no concrete
  authorization bypass. A concrete production caller and joined
  PA/Ops acceptance are also open. No PA staging, either production instance,
  Ops release flag, or existing public link changed at this checkpoint.
- The internal adapter now has a non-injectable, server-only composition with
  the D1-backed current-reviewer check. A caller-supplied fake callback is
  ignored by that path; its focused adapter suite passes **13 tests** and
  Operations TypeScript passes. This is still unmounted and does not promote
  a mapping. The controlled activation design calls for a separate acquired
  canonical mapping table and owner epoch, exact legacy/acquired collision
  checks, and coordinated changes to 0082, 0056/0065, 0086, the directory
  materializer/relationship/delivery preparation, onboarding recipient proof,
  project refresh, and legacy outbox settlement. No synthetic 0054 outbox
  acknowledgement is acceptable. PA/D1 cannot be atomic; a live consumer
  must apply a freshness bound or a PA-verifiable use check.
- Public-link cutover audit: existing `/s/{publicId}` links and passwords are
  anchored to immutable share/project IDs, token hashes, lifecycle and R2
  prefixes, not the new acquisition receipt. Preserve those rows and versions,
  the legacy public hosts and `LEGACY_CLIENT_ORIGINS`, and the current share
  prefix. Delegated client handles and authenticated delivery handles bind
  exact source/binding versions and correctly fail closed if those change;
  migration must preserve their versions or deliberately reissue them. PA
  guest revoke remains tied to its legacy receipt/source identity, so an
  acquired-mapping cutover needs an explicit compatible revoke path before
  old links are considered safe. Add a cutover fixture for existing share
  session-to-manifest-to-download and guest revocation before activation.
- The additive 0116 migration adds a separate **inactive-only** acquired
  canonical-mapping candidate table. It requires the exact 0111–0115 review,
  0112 command, 0114 PA response, and 0113 receipt chain, and rejects an
  overlapping 0054 legacy external/public ID even when that old mapping has
  a NULL history epoch. The native ownership epoch is deliberately NULL and
  cannot be confused with PA's history epoch; no row is activatable or read
  by public paths. A populated migration-chain fixture confirms historical
  rows survive and an exact legacy collision is rejected. The focused D1
  test and a second fixture prove a non-colliding exact receipt chain stores
  only an inactive candidate and cannot update or delete it (**14 tests / two
  focused files passed**). Operations TypeScript and the production build
  pass locally. This is
  **not** a promotion implementation: a native owner-epoch ledger, exact
  current PA/reviewer validation, future legacy-write collision fence,
  coherent reader branches, and rollback/read gates remain required.

### September 14 — native owner-epoch foundation and PA-use freshness audit

- Additive 0117 now stores an immutable, one-per-receipt native owner-epoch
  **claim** separately from PA's history epoch. The epoch is unique across
  claims, and claim/epoch IDs require lowercase UUID-v4 shape. An exact-chain
  and current-local-version trigger, bidirectional legacy/acquired reservation
  fences, and a cross-history acquired-identity fence protect the inactive
  candidate namespace. The separate activation table accepts only `inactive`;
  no route or public reader consumes either table. A privileged D1 writer can
  still invent a claim, so SQL is not reviewer or PA authorization proof.
- Focused synthetic D1 and proof-adapter acceptance passes **18 tests / 3
  files** after QA corrections, including populated negative and positive
  complete migration chains through 0117, duplicate/invalid claims,
  failed-batch rollback, NULL-history legacy overlap and strict PA receipt
  proof behavior. Operations TypeScript check passes. The separate small
  positive claim fixture uses simplified 0111–0115 stand-ins, but the added
  full-schema positive fixture now covers the exact inactive chain. None of
  these tests authenticates a native-owner decision or PA-current cutover.
- Read-only PA v2 source audit found no conditional current-binding/profile
  status read endpoint. Its outward v2 integration API currently routes only
  pricing-hint and draft-quote writes; the portal-v2 routes are outbound
  projection receivers. PA's principal `authorization_version` is neither
  projected in principal `sourceVersion` nor advanced for every effective
  entitlement/binding change. A delivered snapshot therefore cannot establish
  PA-current access at a later use. The 26-hour snapshot-health window is not
  an authorization lifetime, and the approved ten-minute PA outage email is
  not an authorization lifetime either.
- Before activating or refreshing an acquired PA-derived mapping, add a
  generic, dedicated-scope PA conditional status capability for the exact
  selected profile/workspace/root and optional principal/identity binding.
  Ops must match its revision/hash and fail closed on PA denial, change or
  unavailability; a cached projection or successful historical receipt is not
  activation proof. Do not activate/refresh PA-derived mappings during a PA
  outage. Transitional PA-originated guest, delivery and financial-link paths
  need an explicit authority inventory and compatibility tests, not a blanket
  live-PA dependency. **This is not a PA check on every native Ops-owned
  portal/share operation after cutover.** Native membership, delivery grants
  and revocation must be governed by Ops so PA outages do not stop native work.
  This is a design gate, not an implemented API or permission to relax current
  denial behavior.
- The supplied LAN staging controller returned HTTP 200 with `healthy: true`
  through a read-only, elevated-network `/health` probe. That checks reachability
  only; no credentialed PA contract, migration, or workflow acceptance ran.
  No credentials were logged, no staging data was changed, and neither PA
  instance nor Ops was deployed.

### September 14 — current PA main versus Ops generic-v2 transport

- Verified the PA remote `main` ref is `51e333fb` before creating an isolated
  `codex/api-first-portal-binding-status` worktree from that exact commit.
  Neither local `main` nor `dev` was modified. Read-only route inspection of
  this current PA main and the in-root PA worktrees found no public
  `/api/v2/capabilities` or `/api/v2/bindings/{kind}/status/{externalId}` route.
  Current public v2 integration routing exposes only dedicated pricing-hint
  and draft-quote endpoints. Ops's existing generic-v2 binding reader first
  requires the capabilities endpoint and the exact binding-status capability;
  therefore a portal-specific status route alone would not satisfy the Ops
  preflight or authorize acquired-mapping activation. Treat generic PA v2
  capability metadata, application-bound scoped keys, and exact resource
  binding/current-read contracts as a joined release blocker, not as complete
  because Ops transport and synthetic tests exist. No PA or Ops production
  state was changed by this inspection.
- PA writer inventory found a second hard gate: the current generic Sync
  Contract v2 is snapshot-only in production call paths. Its event writer is
  not invoked by client, organization, project, payment-import or project
  planning mutations, so observed rows cannot yet sustain a truthful generic
  revision/change feed. Direct source-version updates do not substitute for
  an atomic v2 event. Portal principal `authorization_version` also misses
  entitlement, identity-binding, principal-client association and some
  archive/restore changes. Before any binding-status/current-authority result
  is trusted, wire transaction-bound mutation events across the actual writer
  inventory and advance principal authorization generation on every effective
  change, with no-op and rollback tests. Do not advertise those capabilities
  from `/api/v2/capabilities` until their routes and writer fences are real.
- Re-ran the current Client baseline before PA changes: public-share route,
  migration/password and lifecycle suites pass **26 tests / 3 files**; bulk
  download backend, cache migration, concurrency and client suites pass **71
  tests / 4 files**. These local tests cover important existing-link and
  resumability behavior but do not prove live public URLs or a future
  authority cutover. Retain deployed-link acceptance and rollback gates.
- In isolated PA branch `codex/api-first-portal-binding-status`, local commit
  `bf8aced6` adds only an application-bound, dedicated-scope
  `/api/v2/capabilities` handshake and migration 0088. It advertises no
  directory, change-feed, or binding-status capability. Focused PHPUnit
  passes **3 tests / 16 assertions**, migration-file validation sees **88
  files**, and PHP lint passes. No PA build, staging migration, or production
  deploy has run. The write-event/authorization-generation and exact binding
  endpoint gates above remain open; do not mistake this foundation commit for
  a ready cutover.
- Compared PA's public client-onboarding form with Ops' native recipient form.
  Ops already preserves the PA individual/organization fields and responsive
  one-/two-column structure; no recipient fields are missing. Keep Ops'
  fragment-token handling, explicit prefill authorization, shared validation,
  and submission recovery instead of copying PA's query/session-token or
  prefill behavior. Focused local Client onboarding tests pass **36 tests / 5
  files**, and desktop/mobile browser fixture tests pass **44 tests**. These
  verify local layout and behavior, not a live recipient-link acceptance test.
  A PA-only validation mismatch was corrected in local commit `b97fd2f5`:
  its form and database allow a 32-character postal code, but the submit
  controller truncated it to 20. The submit limit now matches 32; the focused
  PA onboarding regression suite passes **6 tests / 113 assertions**. The
  native Ops form needs no field or layout copy for this requirement.
- Focused Ops onboarding tests covering fields, issuance, submissions,
  decisions, existing-client prefill and D1 notification cycling pass **45
  tests / 6 files**. This remains local fixture evidence, not a live owner or
  recipient acceptance of the eventual API cutover.
- Corrected an API v2 key-design mismatch before staging: Ops deliberately
  sends the same configured key for capabilities preflight and a subsequent
  resource call. A capabilities-only key could never satisfy that sequence.
  PA must require an explicit `api.capabilities.read` grant while allowing the
  *same bound key* to carry additional narrowly scoped resource grants; legacy
  `full` does not inherit the new scope. The PA branch now does this, with
  focused PHPUnit **3 tests / 17 assertions**. Future capabilities metadata
  must advertise only routes actually implemented and granted to that key.
- PA local commit `70f760d5` adds default-inert directory revision state and
  transaction-bound, no-op-suppressed change rows for ordinary client and
  organization creates/core updates. The exact Ops directory read route is
  still **not exposed or advertised**: other writers, deletes, relationship
  changes, existing-row backfill and application authorization-generation
  advances are missing. Do not use these partial revisions as proof of current
  access or complete history. Independent QA found no defect in the scoped
  patch; focused PA tests pass **15 tests / 170 assertions** across the new
  foundation and existing onboarding/layout suites; migration-file validation
  sees **89 files**. Real MySQL concurrency and staging migration remain open.
- PA local commit `b2d3c4de` now records revisions for approved
  onboarding merges, payment-processor client creation/enrichment, client
  archive/purge/restore, and organization deletion with linked-client FK
  detachment. A review caught and corrected an organization/client row-lock
  inversion before release: deletion now locks children before the parent and
  re-reads children before recording detach revisions. Focused revision tests
  pass **4 tests / 31 assertions**; the final complete PA suite passes **816
  tests / 6,595 assertions, 91 skipped** and an independent re-review found no
  new definite correctness defect. This does **not** close the full writer inventory,
  backfill, authorization-generation, API read-route, MySQL concurrency, or
  staging acceptance gates. No new capability is advertised and no PA deploy
  or production state change has occurred.
- PA local commit `78188b98` closes the organization/client attach and detach
  writers plus an alternate JSON organization-create path. Attach preserves
  authorized administrator reparenting, rejects a stale old-organization
  precheck, and does not write a revision for an already-attached no-op;
  detach records only after one actual row change. Focused adjacent PA suites
  pass **17 tests / 203 assertions**, lint and whitespace checks pass, and
  independent QA found no remaining definite functional issue. These tests
  are mostly source-order and isolated-helper assertions, **not** a real
  MySQL concurrency or controller acceptance proof. A second contract audit confirms Ops needs both
  exact generic v2 directory reads and exact client/organization binding-status
  reads, advertised by the same-key capabilities handshake. PA main and the
  local foundation branch expose neither read family yet. Binding status must
  prove the requested external ID, live public ID and resource revision for
  the selected application/source/history epoch; absence, revocation, remap,
  stale revision, scope loss or transport uncertainty cannot promote a mapping.
  Staging must test each case before any cutover. The legacy HMAC portal
  projection is not a substitute for this current-authority proof.

### September 14 — PA generic-v2 directory reads and binding command checkpoint

- The isolated PA branch now has default-off client/organization directory GETs,
  exact application-scoped binding-status GETs, and existing-record binding
  POSTs. The POST records an application-scoped idempotency receipt and advances
  authorization generation atomically with a new binding. It does not create a
  client or organization. Routes are independently gated by
  `APP_API_V2_DIRECTORY_READ_ENABLED`, `APP_API_V2_BINDING_STATUS_ENABLED`, and
  `APP_API_V2_DIRECTORY_BINDING_ENABLED`; legacy `full` API keys do not inherit
  any of these explicitly granted scopes.
- A concurrency review found snapshot-stale reads possible under MySQL's
  default isolation. The GET paths now take current-row locks around identity,
  resource and revision verification. This is source-level mitigation, **not**
  a substitute for real-MySQL concurrency tests. Focused tests pass **23 tests /
  160 assertions** across the new foundation; the final integrated PA suite
  passes **832 tests / 6,710 assertions, 91 skipped**. Migration-file
  validation sees **91 files**, and PHP lint and staged whitespace checks pass.
- Migrations 0088–0091 are additive and local only. Existing PA application
  registration and key binding now have a generic **local-only operator CLI**
  (dry-run, explicit apply, dedicated non-`full` key, atomic app/auth-zero/key
  bind, exact no-op rerun). Its isolated tests pass **6 tests / 16 assertions**.
  Local PA commit `35e9ce06` contains the utility; the complete PA suite
  passes **838 tests / 6,726 assertions, 91 skipped**. The CLI has not been
  run against either PA instance. Old-row
  revision backfill, all remaining lifecycle mutation coverage, and staging
  acceptance still block activation. No PA staging or production migration,
  feature enablement, or authority cutover occurred. Ops must continue to use
  current public-link permissions and must not infer access from these dormant
  tables or synthetic tests.

- A default-dry-run, local-only PA directory backfill utility is now prepared
  for existing client and organization rows. It validates migration/schema
  prerequisites, processes bounded resumable batches, and refuses divergent,
  tombstoned, missing-change, or future-change revision history instead of
  repairing it implicitly. Apply requires explicit confirmation and a
  maintenance-window assertion; no backfill has run on staging or production.
  The focused backfill tests pass **8 tests / 25 assertions**, including a
  future-change regression. Real MySQL rehearsal, coverage reconciliation,
  and the remaining access-generation writer inventory remain release gates.
  Local PA commit `4d861e28` contains the backfill; the final full PA suite
  passes **846 tests / 6,743 assertions, 94 skipped**. The commit is not pushed
  or deployed, and the utility has not been run against a live database.
- The current PA binding-status proof deliberately requires its stored resource
  revision to equal the live directory revision. A later legitimate client or
  organization edit therefore returns a conflict until the binding is advanced
  through a separately reviewed, revision-fenced command. That refresh path
  and its Ops reconciliation are **not implemented**. Do not activate binding
  acquisition or treat the first binding receipt as perpetual current proof.
  The replacement should be a separately capability-scoped, default-off
  idempotent refresh POST, pinned to the same application/source/epoch,
  external ID, public ID, expected old revision and current new revision. PA
  must verify the live projection and generation under locks, update only the
  binding revision, advance generation, and append a receipt. Ops must append
  new refresh evidence after current profile/reviewer/status checks; it must
  never rewrite the original acquisition, retarget a mapping, or regenerate
  existing public links. Conflict or uncertain transport pauses reconciliation.
  Proposed wire shape: `POST /api/v2/directory/{clients|organizations}/bindings/revisions/commands`
  with an immutable command UUID, external ID, expected prior/live revisions,
  and expected authorization generation. The request deliberately omits a
  replacement public ID; PA derives that from the existing binding. The
  response returns the bound public ID, prior/live revision and resulting
  generation. The route requires a new explicit per-resource refresh scope,
  same application/source/epoch headers, and a separate default-off flag.
  Local PA commit `f5163f42` implements this dormant producer half with
  migration 0092 and source-before-state locking across the old binding paths.
  Focused binding/migration tests pass **21 tests / 111 assertions** and the
  complete PA suite passes **855 tests / 6,781 assertions, 94 skipped**.
  Its Ops transport/reconciliation ledger, real-MySQL concurrency checks,
  staging proof and both-instance deployment remain open; no PA flag or route
  has been enabled in staging or production.
  A separate, unmounted Ops refresh transport adapter now validates this
  exact contract, including preflight capability, bounded no-cookie response,
  identity/receipt shape, decimal-safe generation increment, and private
  validated-acknowledgement evidence. Focused Ops Vitest passes **8 tests**
  and TypeScript `--noEmit` passes. This is transport only: it sends nothing
  until called, persists no D1 refresh ledger, and changes no mapping or link.
  Tracked Ops migration 0118 adds append-only refresh
  commands, transitions, and exact success receipts. It pins the acquired
  native-owner claim, local version, source/application/history identity,
  external and PA public IDs, revisions, generation and request hash. A unique
  acquired-or-refresh predecessor prevents forks; legacy mapping overlap and
  noncanonical decimal values fail closed. It does not activate a mapping or
  alter any public link. The combined transport/ledger focused suite passes
  **11 tests / 2 files**. The real D1 migration-chain suite through 0118 now
  passes **2 tests / 1 file**, including populated canonical history and a
  noncolliding acquired chain that remains inactive.
  The invitation-client Zod/Hono type mismatch discovered by a fresh Ops
  check is corrected in local commit `4146cbf` without dependency changes:
  Operations now validates its copy of the shared wire shape using its own
  Zod runtime, and the cross-app test invokes the Client router directly.
  `npm run check` passes and the two focused suites pass **13 tests**. Runtime
  settlement, uncertain-response recovery, staging proof, and public-link
  acceptance remain open. A 409, malformed response, timeout or changed
  owner/local version must pause reconciliation; no receipt may rewrite the
  original acquired mapping or a public link.
- The next generic PA directory write capability is not a thin SQL route.
  Existing organization updates coordinate the source row, source version,
  API v2 revision, portal projection, and reusable address-book entry. A
  direct API update would silently skip side effects. Extract and test a
  shared non-upload organization writer first, then add a separately scoped,
  default-off conditional/idempotent organization command with a durable
  receipt and real-MySQL rollback/concurrency proof. Focused existing PA v2
  directory tests pass **26 tests / 161 assertions**; this proves the current
  read/bind path, not the missing write capability.
  Local PA commit `717dadd9` now extracts the shared non-upload organization
  mutation boundary. Browser edits delegate to it, while it keeps the source
  row/version, reusable billing address, API v2 revision, and portal projection
  in one transaction; tax-file paths are unchanged. Relevant PA workflow
  tests pass **42 tests / 804 assertions**. The scoped conditional API command,
  durable receipt, and real-MySQL concurrency proof remain to be added.
- Authorization-generation review found that PA key scope/IP edits and key
  revocation did not advance the application watermark, although routes already
  denied revoked keys. Local PA commit `f23c8155` now atomically advances it
  for semantic bound-key scope/IP changes and first revocation, skips unbound
  legacy keys and no-ops, and fails closed on missing/malformed/overflowing
  state. Focused tests pass **15 tests / 48 assertions**; the complete PA suite
  passes **851 tests / 6,754 assertions, 94 skipped**. This is source-level
  proof, not a real-MySQL/staging concurrency acceptance. Initial unbound-key
  creation and first atomic application/key bind need no separate increment.

### September 18 — Project lifecycle and fresh-D1 staging gates

- Project lifecycle acceptance passed against the bound PA staging application:
  archive advanced revision 4 to 5, an exact idempotency replay returned the
  same result, and a changed-body replay returned 409; restore advanced revision
  5 to 6 with the same replay/conflict behavior. The projection hash remained
  unchanged. Archive revoked the existing public presentation, and restore did
  not silently republish it. No credential or private public-link URL is stored
  in the evidence.
- The authenticated joined Operations-to-PA acceptance harness is merged into
  Operations main in PR 90. It is staging-origin-only and mutation-gated, uses
  the verified signed-in Operations principal plus CSRF/origin enforcement,
  creates only a disposable project, proves exact replay and changed-body
  conflict behavior, and compares an existing Operations public link before
  and after. Running it still requires the staging Operations/Client Workers,
  a bounded native-authority packet, and an existing 200 Operations-side public
  link; it does not accept the PA lifecycle fixture as a substitute.
- A new empty-D1 rehearsal exposed that Wrangler's remote D1 transport rejects
  nested trigger `SELECT CASE ... RAISE(...) END` statements that local SQLite
  accepts. Six historical migration definitions were changed only to the
  equivalent `SELECT RAISE(...) WHERE <same predicate>` form, and a lexer-based
  repository invariant now prevents the incompatible form from returning.
  Reviewed bootstrap chain hashes were advanced. Isolated staging D1 databases
  accepted the complete 132-row Client chain (both `0199` filenames, final
  `0213`) and 122-row Operations chain (final `0122`); second migration lists
  were empty, both foreign-key checks were clean, and each database contained
  exactly one synthetic staging owner. Existing applied D1 ledgers are not
  replayed or rewritten.

### September 19 — Directory-v2 joined staging acceptance

- The bounded Directory-v2 staging window completed with a real PA create for
  public ID `63382355879f38ef7d77e7e97424188e`. Command
  `4349b923-d993-4022-9dce-50ef62a85d35` returned the exact replay result,
  rejected the changed body with `409`, and advanced authorization generation
  `41 -> 42`. PA and Operations verified the exact configured
  source/application/history identity and retained durable Operations
  acknowledgement, mapping, and audit evidence in
  `staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f`.
- The applied transport/receipt contract fixes are `e38c61a`; current inspected
  Operations staging is `07a1d7d0-a20d-4122-befa-00ac2cdaae9a`. The bounded
  authority window is closed: the Directory acceptance route was removed, the
  selected PA connection disabled, no actor command/lease/Directory write fence
  remains, and the reviewed revocation migration verified inactive authority
  versions, Project-grant generation `2`, and its immutable receipt. This is
  not Project-v2 acceptance, a PA `main` merge, production readiness, or full
  regression evidence.

### September 19–20 — base Project window checkpoint

- The exact PA candidate remained `ff42c3432f39e50e92058b21d7e4942c26f5b355`.
  Exactly five base Project flags were enabled:
  `APP_API_V2_PROJECTS_CREATE_ENABLED`, `APP_API_V2_PROJECTS_READ_ENABLED`,
  `APP_API_V2_PROJECTS_WRITE_ENABLED`,
  `APP_API_V2_PROJECTS_BINDING_STATUS_ENABLED`, and
  `APP_API_V2_PROJECTS_INVENTORY_ENABLED`. Capabilities returned HTTP `200`,
  `implementedEndpointCount: 6`, and `grantedCapabilityCount: 6`.
- Project inventory GET returned an empty-body `409` because the deliberately
  stale browser-edited binding remains. No joined mutation ran, and static
  generation must not be guessed. This remains a checkpoint, not joined
  acceptance.
- Temporary staging-only Ops packet
  `staging-authority-project-v2-20260919-215846z` was provisioned and safely
  revoked. Pre-revoke counts were `actor_fences=0`,
  `project_pending_or_leased=0`, and `directory_pending_or_leased=0`;
  post-revoke readback was admission active `0`/version `4`, profile `1`,
  directory grant `0`, project grant `0`/version `4`/generation `4`, live
  proofs `0`, one revoke receipt, one revoked provision approval, and no
  pending revoke migration.
- The next gate is a read-only PA-side DB readback of the current Project
  authorization generation for application
  `150cb108-af37-4973-ab6e-f6d991a6e8c8`, without refreshing stale bindings.
- The local Operations Project transport now recognizes PA's exact stale-binding
  recovery envelopes without mutating anything. Inventory accepts only a trusted,
  identity- and request-correlated `binding_stale` discovery containing the
  selected external ID. Binding status additionally requires the current
  generation, exact binding external/public IDs and pinned revision, plus a
  strictly newer live revision and valid projection hash. Bare `409` responses
  remain ordinary conflicts; malformed or untrusted JSON fails closed as
  uncertain. No refresh command, retry loop, or automatic recovery is wired.
