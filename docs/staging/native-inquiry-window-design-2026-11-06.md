# Native inquiry staging window: design constraints

This is a staging-only design, not an activation or evidence of readiness. The
existing release evidence explicitly prohibits activating the native inquiry
gates through the generic staging release. Do not modify that rule to force a
deployment through it.

## Current evidence and limitations

On November 6 the existing synthetic recipient was read through the owner
review UI: service-home access was in effect and service requests were not
included. The UI revalidated owner authority. A prior schema comparison found
the required Ops and Client D1 definitions; repeat current checks before any
change. Read-only Cloudflare version metadata showed the two Ops inquiry flags
absent on both active and candidate versions. Both Client inquiry flags were
true on its active and candidate versions. These facts are point-in-time and
do not prove the recipient's request consent or a successful live request.
The observed Ops candidate already uses 128 text, JSON, or secret bindings.
Adding flags needs a separately reviewed binding-budget solution. Do not assume
that removing an explicitly false flag is equivalent to leaving it absent:
`PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED` has an absence-sensitive Viewer
path. Source checks alone do not prove the deployed bundle is equivalent.

## Operator requirements

Use a separate operator for Worker configuration; the retained directory
authority operator changes D1 grants and must not be repurposed for Workers.
Start from fresh provider reads of the exact staging account, both Worker names,
active and candidate version UUIDs, traffic, runtime metadata, service bindings,
settings and schedules. Pin the complete settings and identify the exact
candidate and prior rollback versions. Check the Client-to-Ops inquiry ingress
binding, required D1 definitions, exact source, and current owner admission.
Preserve all unrelated settings and the existing Client flag states; do not
assume four flags are off or turn previously enabled flags off during cleanup.

The reviewed window must identify one synthetic target, client record,
recipient binding and verified principal using current authoritative records,
not an email match. Keep private identifiers in protected evidence. Bound the
window and pin the exact Ops flags being changed. Persist an intent before
provider mutations, read back each change and hold on ambiguous outcomes without
blind retry. Confirm retained frontend bytes and paths before switching traffic;
the 48-hour clock begins at actual cutover, not candidate upload.

The owner API intentionally refuses to issue a request-capable confirmation
while the Ops capability gate is disabled. After the reviewed staging window
is open, use its exact-target workflow: issue the v4 confirmation, obtain the
verified recipient's explicit consent, review and confirm it as owner, and
verify publication and immutable paired receipts. Exercise the selected
synthetic request, idempotent replay, denial for another principal, and
revocation. The existing dispatcher allows revocation after the grant gate is
disabled; verify this behavior rather than assuming a flag change revoked a
grant. Close the window by restoring the exact previously observed configuration
and verifying both control planes and recipient access; reconcile uncertain
receipts before repeating anything. Do not send messages to real clients.

No part of this design grants access, changes staging or production, or proves
that the operator exists. A complete implementation and independent review are
still required before live acceptance.
