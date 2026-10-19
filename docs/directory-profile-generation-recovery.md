# Profile command generation recovery

PA authorization generations cover an application, so an unrelated successful
command can invalidate an otherwise current client or organization update.
Recovery retains the original profile, actor, selected destinations, public
identity, relationship and expected PA resource revision. A different resource
revision or identity requires review; recovery never promotes that revision.

The profile transport accepts only PA's exact typed pre-mutation
`authorization_generation_conflict` response. Its private in-memory evidence
binds the request bytes, source/application/history identity, request ID, public
ID and regular or contact-profile endpoint. Create-command evidence and copied
JSON errors cannot authorize a profile successor. A historical generic 409 is
re-proved by sending the same immutable command, not by assuming nonexecution.
Network uncertainty cannot authorize a successor.

The original dispatcher reservation remains authoritative. Staff updates retain
the original selected edit and client identity-link grants, current admission
and profile, scoped denies and current target. Already acknowledged siblings do
not need new authorization. Shared member identities, versions, profile and
command lineage remain exact. Portal updates continue through their original
grant, membership, correspondence and fresh private Client authority witness;
they never borrow staff permissions.

Automatic own-client grants additionally retain their activation proof's exact
PA principal and association, checked again before the successor POST. A shared
edit retains the original login grant's live own identity and separately checks
the destination's proof from the same automatic decision and current group.
The two PA principals and associations may differ. The original PA revision may
advance after an already acknowledged sibling; the destination revision must
still equal the original command's expected revision. A secondary template need
not have been bound by a second login. Both proof identities and observations
are retained, with local snapshots bracketing validation and an unexpired Client
witness required after the final identity read. Explicit
staff-reviewed manual grants retain their existing current Client entitlement
policy. They are recorded as `reviewed_manual`, without inventing an own-client
role or historical PA association version.

After fresh PA binding/profile observations, the dispatcher reservation is
revalidated. Bounded complete authority rowsets bracket that semantic check.
The same count-and-row-equality fences, including missing rows and grant
generation, are checked with a short expiry in the atomic ledger/outbox append.
This prevents new denies, membership changes or head changes from racing the
append. The successor still obtains current authority immediately before its
POST. These fences do not claim cross-service database atomicity; PA's unchanged
resource-revision CAS remains required.

Migration 0220 adds a separate immutable update-recovery ledger. Its structural
guards allow only the command UUID and observed authorization generation to
change, and limit a chain to three successors. Original terminal commands,
materializations and outcomes remain unchanged. Shared effective-materialization
and unsettled views recognize the separate create and update chains. Existing
normal dispatch continues on schema 0219; new recovery is unavailable until the
complete 0220 schema is installed.

The normal outbox drain remains the gate and retains its twelve-command budget.
An additional fair lane observes terminal update conflicts. Operational check
rows provide bounded backoff; concrete revision, association or identity
conflicts require review. Approved onboarding existing-company updates also
require onboarding administration to remain enabled, the original pending
approval and a semantic no-op company profile. They do not authorize arbitrary
company edits, financial changes or new grants.

Native-create enrollment provenance retains its historical JSON shape. A
missing enrollment epoch property can only use native-create provenance when
the immutable intent, audit, configured source and current mapping independently
pin the exact non-null epoch. No epoch is filled in or promoted. Actual pre-0065
history retains immutable NULL command epochs and fails closed before network
access; the migration regression tests that negative case, not an invented
fully pinned five-field writer path. Reviewed import is the explicit migration
path for such unpinned history.
