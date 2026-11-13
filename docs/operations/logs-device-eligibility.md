# Explicit employee controller eligibility

Source preparation only. This does not grant an employee access, activate Logs,
apply a migration or establish controller acceptance. Merger owns the release.
The original Logs worker/UI author must implement and qualify the matching
revision checks before unrestricted controller activation.

## Operations authority

Controller usernames remain identifiers. A username, active employee, PA role,
email domain or `flight_logs.view/import` permission does not grant device use.
The additive Operations migration `0243_staff_logs_device_eligibility.sql`
creates an initially empty, per-person allow/deny record and an immutable
command/audit ledger. It seeds no staff grants or role permissions.

The private StaffDirectory RPC now provides
`getPilotDeviceAuthority(staffId) -> { eligible, revision }`. Username resolution
returns `{ staffId, eligibilityRevision }` only for an explicitly allowed,
active employee with matching current native identity and admission version.
The compatibility `isActiveStaff` method now means eligible for controller use;
it must not be used alone to validate a token's generation. Missing schema is
unconfigured and denies device authority; partial schema or storage errors fail
as unavailable. Ordinary own-flight viewing remains separately authorized.

## Managing a staff profile

`GET /api/staff-device-eligibility/:staffId` returns current username, eligibility
state/version, a CSRF token and the verified human-session deadline.
`POST` accepts exactly `commandId`, `expectedRevision`, `expectedAdmissionVersion`,
`effect` (`allow` or `deny`) and `reason`. Both expected values must come from the
GET state the administrator reviewed, rather than silently replacing them with
a newer readback. It returns an immutable receipt. The exact two-method
family verifies its own Access JWT/native identity before the generic staff
wrapper. It requires current **global `roles.manage`**, with explicit deny
precedence; an administrator boolean is never sufficient. It permits an
authorized manager to explicitly manage their own eligibility.

Requests are same-origin/CSRF protected and bounded to 4 KiB. Actor identity,
verified deadline and actual target admission are independently derived on the
server. A new command is rejected with 409 if the reviewed admission or grant
revision has changed; reload, review, then deliberately create a new command.
An unresolved retry keeps the exact original five fields and command ID.
Alternate
sign-in bindings are rechecked in the write transaction. Expired identity,
changed actor/target versions, lost permission, concurrent revisions and
conflicting command reuse cannot write a grant. A retry of the same command
returns the original receipt without a second audit or mutation. There is no
delete route. Grant and command histories are retained.

The source successor uses the `logs-device-eligibility-v2` request hash, including
the reviewed admission version. This is an explicit source-only v1-to-v2 boundary;
no deployed v1 receipts exist while live SQL and gates remain unapplied. Earlier
ff074 qualification does not establish acceptance of this successor.

This is separate from the existing bulk access-control form. Older open UI
versions do not unknowingly clear device eligibility. Each explicit eligibility
command creates a new revision, including deliberate reauthorization. The UI
must call it only for a permission change or explicit reauthorization; editing
an unrelated profile field must not issue a grant command. Team employee detail
is the single management home; Flight logs links to it.

## Logs worker and rollout requirements

The matching Logs worker must persist the eligibility revision on pending
sign-in and device token records, obtain fresh authority at approval/issuance,
and compare the token's issued revision on every use. Missing or mismatched
revisions deny. Existing-use cache is deployment/authority/revision scoped and
bounded to at most 60 seconds; approval/issuance cannot use a cached allow.
Revoke/regrant and archive/restore must never revive old device credentials.
An archived admission invalidates its grant; restoring requires a new explicit
grant and new controller approval. Historical flights and raw logs remain
attributed and retained. Granting device use never changes view/import rights.

Coordinate schema-before-code, explicit pilot review and both sides of the RPC
contract. Earlier boolean-only tokens cannot be silently grandfathered. Do not
deploy this source as an unreviewed production change: absent explicit grants
the new directory denies device use. Preserve ordinary staff sign-in, existing
public links, and the actual 48-hour frontend asset paths and bytes.

Prepared qualification includes a full 235-migration D1/actual Worker/JWT suite,
existing flight-route regressions, races/replays/late denies, and archive/restore
through the existing lifecycle service. Those prepared suites require their
own executed results; prior employee-slice tests do not qualify this successor.
Local pure policy and in-memory SQLite guard checks do not establish D1, real
Access, controller, UI or live-data acceptance.
