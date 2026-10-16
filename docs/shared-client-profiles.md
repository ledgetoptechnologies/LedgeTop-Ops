# Shared client profiles

An explicitly reviewed shared profile applies the same business contact fields to one or two existing PA records. PA public IDs, source bindings, parent relationships, portal workspace IDs, document histories and public delivery links remain attached to their original records. Documents are still created in PA.

Owners merge two records through a preview and confirmation. They must have the same record type, separate PA sources and identical normalized starting fields. A nested client pair must belong to the same shared organization profile. Matching names or email addresses do not establish an identity link automatically. A single existing record can also receive a shared-profile group through the owner bootstrap action.

Staff saves require current profile permission on every member. Each save atomically records a shared revision, all member revisions and every PA delivery intent. A pending or conflicting PA acknowledgement prevents another save. Retries retain the original mutation ID and business payload; each destination acknowledges independently.

Portal editing requires an additional owner-issued grant for the exact workspace, PA principal, client public ID and shared group. An own-client first-login template binds once to an existing verified portal identity. It does not search for another client by email. Organization edits require an explicit verified-identity grant. Portal actors are audited separately from staff.

Client saves use PA's bound-only `contact-profile/commands` endpoint. PA must advertise that exact endpoint for every client destination. This endpoint changes business contact data while preserving the client's existing login association; changing a contact email does not change the sign-in account. There is no fallback to PA's identity-reconciling profile endpoint.

Portal authority changes block the Ops authority head before Delivery commits the access change. Each profile dispatch obtains fresh Client authority and checks the current owner grant and source tuple. The original accepted request remains an immutable audit witness. A narrowly derived binding-revision continuation can finish an already acknowledged update after the initiating actor loses access; it changes neither profile data nor access.

The authority block remains pending until the same Delivery transaction commits its access changes. A failed transaction stays blocked for the original operation to retry. Bulk source or identity changes reserve a database latch before enumerating workspaces, preventing a first profile visit from creating an unblocked head during the change. Source administration in Ops uses the local authority transition implementation; Client uses its private Ops service binding.

If that original request cannot be retried, an authorized owner can explicitly recover blocked profile editing from the shared-profile page. Recovery pauses portal editing, replaces pending transition ownership, and aligns the existing authority heads in their blocked state before restoring the previous editing gate. A different currently authorized owner can resume the same durable recovery operation. Recovery does not replay access changes: review the actual current access state and retry the intended change separately.

## Deployment

Apply only the new Ops migrations 0207–0209 and Client migration 0232 after their prerequisites. Do not replay historical migration files. Client's `portal_shared_profile_runtime.hooks_ready` starts at zero, keeping portal editing unavailable until the coordinated hooks and service bindings have been verified.

The private named bindings are Client → Ops `SharedProfilePortalIngress` and Ops → Client `SharedProfilePortalAuthorityReader`. Deploy entrypoints before binding their consumers. No proof-bearing public HTTP endpoint or new credential is required.

Roll out reviewed duplicate pairs before single-record bootstrap, then issue exact own-client portal grants. Verify preserved PA/source/workspace IDs, parent relationships, public-link states and delivery acknowledgements. Existing legacy profile routes retain their previous behavior for records outside a shared group.
