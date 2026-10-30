# Client Ops inquiry staging qualification

`CLIENT_PORTAL_OPS_INQUIRIES_ENABLED` is an independent, default-off staging
gate for website, drone, and other inquiries. It does not enable service
catalog reads or native service-request routes. Existing verified-principal,
current-workspace, exact-source, `request.create` allow/deny, membership,
revocation, root-policy, schema, idempotency, and native SQL mutation-guard
checks remain required for every inquiry read and write.

## Preparation and qualification

Before considering a controlled staging activation, the selected staging
release evidence must have current references for
`opsTriageInquiryQualification` and `projectAlphaPortalProjection`. Qualification
evidence has separate local/synthetic checks and selected-staging readbacks:

- Synthetic proof that inquiry authority works with request V2 and native
  requests disabled, uses only the root scope, rejects request denies and
  membership revocation, and applies the native mutation SQL guard.
- Synthetic idempotent replay and conflicting-payload rejection. These tests
  establish storage behavior only; they do not claim staff receipt or email
  delivery.
- Readback from the selected Client staging D1 proving migration 0242 inquiry
  tables are ready, and from the selected Operations staging service proving
  staff-inbox authorization and redaction behavior.
- Readback of the single staging notification email binding, its exact
  `NOTIFICATION_FROM` sender, the triage recipient matching the approved
  staging owner, and the absence of SMTP fallback.
- Source/configuration evidence showing the inquiry discovery gate does not
  depend on catalog or full native request flags, and selected-staging
  readbacks confirming those broader flags remain false. Do not report live
  inquiry readiness while the inquiry gate itself is off.

Preparation does not send a live inquiry email and does not enable the flag.
Keep it explicitly `false` until a controlled activation fits the existing
staging authorization and its recorded scope, preflight, and rollback checks.
This packet and its tests are reference material, not execution approval. New
approval is needed only if a tool or applicable policy requires it or the
proposed activity expands beyond the standing authorized scope.

## Controlled staging activation

For a pilot within the existing authorized scope, use evidence-collection phase with exactly
`delivery.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED` requested. Keep production off,
keep both `CLIENT_PORTAL_REQUEST_V2_ENABLED` and
`CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED` false, name
`opsTriageInquiryLiveAcceptance` as the collecting gate, and provide the
existing applicable staging authorization and concrete rollback reference. The live-acceptance gate remains false until the
pilot has demonstrated a verified Client submission, the exact inquiry in the
authorized Operations inbox, the notice delivered to the configured staging
triage recipient, and revocation denying subsequent writes and history. Record
correlation to the exact inquiry/outbox item, confirm only the approved staging
triage recipient and staging service endpoints were used, and do not involve
ordinary client recipients. The approved staging owner mailbox may be the same
mailbox its owner uses in production; that does not authorize using production
services.

After that bounded pilot, turn the inquiry flag back off while capturing
post-evidence-validation. Full activation policy requires current qualification
and live-acceptance evidence. Do not infer live acceptance from local fixtures,
the presence of an email binding, or a successful D1 write. Production
activation is outside this staging packet.
