# Native portal acceptance dependencies

Checkpoint: September 30, 2026 (UTC). These are dependencies for the current
API-first recipient workflow, not a production activation checklist or an
attestation of client access.

## Keep the workflows separate

- Customer onboarding collects a proposed profile through the private
  `CLIENT_ONBOARDING_RECIPIENT_BRIDGE`. Operations requires its session secret,
  onboarding handoff keyring and audit secret. The recipient bearer proof is
  not an authenticated portal enrollment or a file grant.
- Verified-recipient enrollment uses signed Cloudflare Access identity,
  explicit recipient consent and subsequent owner confirmation. Client requires
  `CLIENT_PORTAL_RECIPIENT_ENROLLMENT_CSRF_SECRET` and the private enrollment
  bridge. Operations uses its own session secret for owner CSRF. These secrets
  are separate; never substitute one for the other.
- Service-home reads use `CLIENT_PORTAL_SERVICE_METADATA_READER` and an
  acknowledged, current `operations.service_home.read` grant. There is no new
  service-home HMAC credential. Home access alone does not authorize files.
- Folder sharing additionally requires the audited recipient-delivery authority
  command, exact home-grant and enrollment pins, current publication/resource
  proof and the private `VERIFIED_RECIPIENT_DELIVERY_AUTHORITY` binding. A
  structured owner proof is not a browser-supplied owner flag or a secret key.
- API-v2 reconciliation requires the exact enabled and scoped
  `PROJECT_ALPHA_API_V2_CONNECTIONS` source/application/history-epoch tuple and
  current durable receipts. A secret name, a cached catalog or a PA login page
  cannot establish that authority.

The canonical all-feature staging secret manifest remains unchanged. It also
lists credentials for legacy projections, media uploads, pricing hints and
other separately gated features. Do not interpret that complete list as a
request to manufacture obsolete PA integrations, copy production credentials
or enable unrelated features just to test native enrollment.

## Fresh inventory and limits

- Client staging is `e35e9fdc-2beb-4a0e-be1b-fa4c372f6cc0` at 100%.
  Remote secret-name inventory includes its dedicated enrollment CSRF secret,
  Delivery session secret, Delivery code pepper and audit secret. Values were
  not inspected. The modern manifest recognizes the CSRF secret; the older
  onboarding-only manifest does not.
- Operations staging is `f5a07171-cb05-4cf3-9251-afe087550920` at 100%.
  Its six listed secrets include session, audit, onboarding keyring, API-v2
  connections and the two Delivery secrets. Presence is not a credential-health
  or scope test. All inspected native enrollment/home flags and the temporary
  API-v2 read-acceptance flag are false.
- Active Ops bindings include the existing workspace/access/authority-v2 and
  inventory-catalog services. They do **not** include the new
  `VERIFIED_RECIPIENT_DELIVERY_AUTHORITY` service. An applied sharing migration
  is not evidence that its newer runtime or private transport is deployed.
- Client migration 0222 was applied to `client-data-staging` on September 30
  after a private, ignored 579,714-byte SQL export. Backup SHA-256:
  `c9f63a892eaa7b565b72c7bcfe4cdcb472b473b9c5e20a248b37098689b2b7cf`.
  Remote readback confirms 141 Client migrations, final filename 0222, no
  pending migrations, an empty foreign-key check and zero delivery heads/audits.
  All nine recreated/new authorization triggers match the reviewed migration
  exactly after line-ending/terminal-semicolon normalization. Client staging
  runtime remains `e35e9fdc-2beb-4a0e-be1b-fa4c372f6cc0`; recipient writer,
  enrollment and portal flags remain false. This is schema acceptance, not
  positive live revocation or an enabled portal. Last Ops ledger count is 151.
  The full local 141/151 runtime chain, foreign keys and idempotency checks pass.
- The visible Client `/portal` screen says the portal is not enabled. This is
  consistent with default-off configuration, not successful recipient access.
- Ops Sync staging is absent. Its old signed projection pipeline is not a
  prerequisite of the native private home RPC itself. The missing API-first
  publication adapter remains a real file-sharing gate; bypassing it with
  cache-only or legacy-proof assumptions is not an acceptable replacement.

## Next acceptance order

The new historical-lineage case now passes in actual workerd after the v7/v8
generated guard split. The split retains every top-level predicate as its own
CHECK inside the same atomic batch; 47 packet/guard tests pass, including denial
and rollback cases. The final full joined workerd suite passes all four cases. This is
local runtime evidence, not live recipient enrollment or delivery acceptance.

The generic API-v2 publication proof contract is implemented and inert,
with eight focused tests passing. It neither creates nor validates live authority
by itself. The next publication path is Ops-native: Operations owns customer
topology, projects, explicit folder reservations, recipient identity and grants.
PA supplies optional linked-record freshness fences, not portal principals or
entitlements. A complete workspace snapshot is not permission to browse it.
Client readers must still apply current individual enrollment and resource
grants, without falling back to legacy permissions.

The separate Ops-native publication contract now has 22 passing focused tests
and a passing Ops type-check. Directory records support explicitly linked
mirrors from both PA instances; projects retain one selected financial instance.
Validated arrays and objects are copied from own data descriptors, so hostile
proxy property reads cannot execute during parsing. This contract remains inert:
producer reservations, atomic publication consumption and live readers are still
required before it can support client access.
Opaque native identifiers follow the actual Directory/project writer grammar:
191 Unicode code points / 764 UTF-8 bytes, without trimming or treating slashes
and dots as paths. Portal workspace/binding identifiers retain their 200 / 800
bounds. Folder prefixes have independent traversal/reserved-segment checks.

Implement and verify the replacement end to end:

- Reserve an explicit Ops workspace root and exact project-to-folder targets;
  never infer them from names, addresses, email or a PA-shaped cache.
- Publish a bounded, immutable root/direct-client/project topology snapshot
  with canonical hashes, counts, versions and exact authority-head references.
- Atomically consume the snapshot into Client publication records and receipts;
  do not write PA principals, entitlements or legacy projection grants.
- Join real hierarchy and file readers to that publication receipt and live
  recipient/delivery authority heads. Service-home access alone cannot expose
  all customer details, projects or files in the workspace.
- Verify retries, duplicate receipt replay, stale-version rejection, partial
  write rollback, revocation without republishing and customer isolation.

1. Reproduce the preserved historical pre-0123 bootstrap and onboarding
   generations through real producers; rehearse v7 acquisition and v8 selection.
   Do not seed approvals, grants, histories or activation receipts directly.
2. Complete Ops-native workspace publication and independent-manager revocation
   across Ops, the private contract, Client atomic guards and actual readers.
   Preserve native identity/version, recipient, project, folder and prefix pins,
   plus source/application/epoch fences where a record is linked to PA.
3. Check current-schema remote readback and private backups, then prepare exact
   current-lineage default-off versions with their new private binding. Never
   deploy the older onboarding-only candidate over the newer staged portal.
4. Use the generated bounded enrollment window for real owner/recipient consent,
   confirmation, service-home, full revoke and acknowledgement/reconciliation.
   Test folder browsing separately under its exact reviewed grant; repeat denial,
   replay, transport recovery and public-link compatibility checks.
5. Restore staging flags and confirm cleanup. Only successful joined evidence
   can create the owner checkpoint for both production PA updates and the
   coordinated production cutover. No production links or grants change here.
