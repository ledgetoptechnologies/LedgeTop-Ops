# Automatic own-profile setup for a reviewed shared company

The shared-company approval receipt references the sealed onboarding plan. Each
selected parent company alias owns a separate new native client record and its
exact PA destinations. Selecting only Drone Services does not create a contact
in Technologies. The first sorted child remains the existing decision receipt's
client anchor; activation uses every selected child, not just that anchor.

The existing activation scheduler recognizes this receipt without adding a
second timer or a browser session. It waits for every child's validated PA ACK,
current enrollment and exact PA-managed own-client principal association. It
checks all principal witnesses twice before reserving the immutable automatic
proof markers together. A manager's general directory-read entitlement does not
select that manager for a contact's own-profile template.

Only after every proof is reserved may activation create the decision-owned
shared contact profile. Migration 0218 supplies a dedicated creation fence for
this approved operation; no interactive merge preview is fabricated. The batch
creates the client group, its sorted complete membership and initial revision,
then removes the completed fence. The group profile is the reviewed contact
profile, excluding `clientType`. Parent company profiles remain unchanged.

Templates use the existing issuer and deterministic operation IDs. A committed
group or template whose acknowledgement was lost is reconciled on retry. A
conflicting group, changed own identity, revoked or suspended template is held;
activation does not replace that identity or restore revoked access. The
original approving staff admission, profile and current edit/link authority must
still apply. Automatic own-profile checks also reject archived local clients or
parents while PA propagation is pending. Manually reviewed grants keep their
existing policy. The activation status records the last observed workflow
state; current grant state and current identity checks authorize every use, even
if an already-active intent remains historically active after revocation.

This operation creates no file or financial grants, grants no company-wide
people access, sends no email and makes no PA profile edits. Existing single
client activation follows its previous path.

The dedicated D1 acceptance fixture exercises real approval, materialization
acknowledgements, shared-profile creation and template issuance. It includes
both PA parent aliases, waiting for all ACKs, primary-only selection, own versus
manager principals, changed principal proofs, changed approving authority,
lost committed acknowledgements, replay and non-restoration of revoked access.
The fixture uses synthetic data and mocked remote PA reads; deployed two-server
acceptance remains a separate release check.

## Review readiness

Company discovery returns `approvalAvailable: false`: it has not captured an
approvable plan. `reviewAvailable` only means the exact candidate can be reviewed.
A prepared plan receipt may return `approvalAvailable: true` after fresh remote
parent reads, only when all migration 0218 protocol objects exist, the sealed
0217 plan is still live and unexpired, the same reviewer admission/profile and
four global grants still apply, and current durable parent heads, enrollment
and authorization-generation evidence match the reviewed children. The final
check reads primary state and opens no execution fence. A 0217-only or partial
0218 installation can still capture review evidence but reports false.

This boolean is an advisory response for that prepared plan, not a permission or
promise that a later action will succeed. The approval endpoint independently
revalidates the entire plan, current PA proofs, configuration, grants and atomic
SQL execution fences. Changing authority after preparation can produce a false
receipt while leaving only the existing immutable review evidence. Expired,
changed or decided plans do not become newly approvable on prepare replay;
completed approval replay uses the existing decision endpoint instead. No new
runtime flag is needed, and the existing staff HTTP gate stays in force.
