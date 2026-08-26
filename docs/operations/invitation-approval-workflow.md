# Organization invitation approval workflow

Status: focused local implementation verified, August 26, 2026. This is not
deployment approval or a claim that the overall client-workspace goal is complete.

## Ownership and user workflow

The existing organization/workspace connection remains the connection. This
feature adds a policy and an operational review queue, not another integration
profile. Operations staff can review the exact workspace policy in Client Hub;
client managers use their existing Team access form. Pending requests appear
separately from issued invitations. Staff review them in the existing Inbox.

- **Allowed:** an authorized client manager can issue an invitation using the
  existing flow. The requested scope and capabilities still require authority.
- **Disabled:** no new invitation or approval request may be issued. Outstanding
  invitation acceptance is blocked; existing accepted memberships are separate.
- **Require administrator approval:** submission records an immutable request,
  requested access terms, an idempotency receipt and audit. It creates no token,
  invitation, membership, entitlement, Access enrollment or invitation email.
  Staff approval authorizes only that reviewed operation. Rejection never grants
  access. Changing a policy does not silently approve old pending requests.

The staff mutation boundary is an active, exactly authenticated staff record,
an existing synced global owner/admin role, and deny-aware **global** `team.view`
and `team.manage`. A division-only grant is insufficient. Client managers cannot
approve their own requests using client authority. Client peer-admin appointment
is a separate remaining workflow; it is not inferred from this staff feature.

Review always rechecks the original requester's membership, scope, capabilities,
denials, eligibility, and delegation lifetime. The staff member's broader rights
cannot enlarge a client's request. Recipient, scope and terms cannot be edited
while approving: reject and submit a new request instead.

## Access, delivery and completion are different states

Approval does not mean the recipient has accepted an invitation. A published
invitation still needs the existing email-bound Access enrollment receipt,
invitation token, verified login and current acceptance authorization. The
existing mail enablement and provider configuration are not changed here.
No production mail is sent during local tests.

Explicit project terms are created when the request is submitted, not recreated
at approval. The first verified project completion therefore starts the same
seven-day grace period even while staff approval is pending. Reopening does not
renew it. Non-project invitations must fit an unlimited delegation ceiling;
a finite project manager cannot issue permanent organization-wide access.

## Transactions, retries and source isolation

Client migration `0165_workspace_invitation_approvals.sql` adds request,
command, approval, audit and publication records. Operations migration
`0041_invitation_review_authorizations.sql` adds immutable staff decision
receipts. Existing invitations, memberships and unclassified historical terms
are not rewritten. Workspace/source coordinates remain exact; matching email,
business grouping or matching public IDs from different producers do not merge
authority.

OPS and Delivery are separate D1 databases. Their writes are **not** one atomic
transaction. The OPS receipt is the durable staff authorization decision. The
approval coordinator stages an unusable invitation in Delivery, rechecks OPS,
then publishes with a fresh Delivery requester/policy/terms fence. New publication
is bounded by the receipt deadline. Uncertain unpublished work is closed and
requires a fresh review; it must never become an automatically issued invitation.

Completed-command replay is distinct from resuming unpublished work. A lost
response must be recoverable with the same actor, key and exact operation after
the publication deadline, without issuing a second invitation. Changed keys,
recipients, scopes, policy revisions or versions are not equivalent retries.
Current staff/source authorization still applies to the replay response.
Client submission keys also retain their identity across the direct-invitation
and approval-request paths. A later policy change cannot turn a retry into a
different action, including for older callers without a reviewed policy
version. Requests share the existing per-manager/workspace submission limit;
exact retries do not consume another slot.
If another administrator has changed the policy since that command completed,
the caller receives a conflict and must refresh; replay never reapplies the old
policy or reports the newer policy as the result of the old command.

The existing invitation maintenance entry also closes expired unpublished
stages in bounded batches, including when mail delivery is disabled. This
removes the staged token payload and returns the request to a new pending
version. It does not publish, email, extend terms or create access. A browser
or process crash therefore cannot leave an unpublishable stage as the only
possible future state; a fresh staff review is still required.

The policy is never temporarily set to Allowed to issue an approved invitation.
Issuance, acceptance and email dispatch recognize only the exact approved
operation. A staged invitation cannot inherit an Allowed-policy bypass if the
policy changes while coordination is running.

## Rollout boundaries

Use coordinated migrations and Client/Operations builds. Operations now mirrors
`CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED`, default off, before it may stage
an approved invitation. Do not set it true as a substitute for Client setup or
Access enrollment. Re-generate Worker types after changing configuration.

The existing native secondary-source invitation acceptance path is still a
separate unfinished contract. Do not manufacture a primary/legacy account to
make it pass. This increment preserves existing supported invitation scopes;
it does not claim full secondary-source onboarding, peer-admin appointment,
completion/24-hour/expiry notices or the final joined business-workflow gate.
Those remain part of the overall goal.

## Verification evidence

- Operations authority and HTTP envelopes: 53/53 tests passed in the final
  two-file run (46.02 seconds, no skips): 30 real-D1 authority cases, including
  migrations through 0041, staff/source binding, scoped versus global grants,
  deny-before-write races, immutable receipts, concurrent replay and publication
  expiration/revocation; and 23 authentication, origin/CSRF, input and bounded-body
  route cases. No production resources were used.
- Client request/approval workflow: all 21 new real-D1 request/approval cases
  and all 15 existing email cases passed in the compatibility run. This includes
  cross-lane retries, an atomic policy-change race, concurrent publication,
  submission limiting, mandatory enrollment receipts and renewed grant versions.
  The combined run was 61/62 (450.77 seconds), **not** a passing whole gate:
  one pre-0129 workspace fixture exposed a new scope query's dependency on a
  missing native-contract table. After the narrow correction, the workspace
  suite passed 26/26 (161.44 seconds) with an explicit authorized-project-options
  assertion, and Client type checking passed (4.72 seconds). Thus all 62 distinct
  cases have passing evidence. The unchanged request/mail paths retain their
  earlier passing results; this is not a claim that the initial combined run
  passed. The compatibility path uses the existing bounded, deny-aware legacy
  authority helpers only for explicitly pre-contract schemas, never a
  missing-table exception bypass on current schemas.
- Joined Client/Operations coordinator: 21/21 passed (364.43 seconds, no skips),
  including the real local request, review, publication, mock email, enrollment
  receipt and recipient acceptance path. Policy/permission changes, deadline
  replay, uncertain publication and failed cleanup were also exercised. The
  initial policy response/fingerprint defect is corrected. Final Operations
  type checking passed after a test-proxy overload correction.
- Operations browser workflow: 122 distinct cases passed on the frozen UI
  build. The initial combined run passed the unchanged Client Hub/Inbox 84
  cases; the final invitation suite passed 38/38 (22.1 seconds) after correcting
  test selectors. The earlier combined run's eight selector failures are not a
  passing combined gate. The 49 focused Operations UI/route/Inbox unit tests
  also passed.
- Client browser workflow: 140/140 passed in the three-file run (3.1 minutes,
  no skips), including invitation requests, existing portal flows and project
  access terms. The two responsive cases per app were also rerun for fresh
  375px/1280px top-of-page and scrolled-viewport captures (2/2 Operations and
  2/2 Client). Review, policy and request-history controls were visually
  inspected; the apparent mid-page header in full-page captures was the fixed
  header at the capture scroll offset, not an additional overlay in the layout.
- Both final app builds and generated Worker-type checks passed. Builds retain
  existing large-chunk warnings. Migration compatibility is covered by the
  real local D1 gates, not a production migration.
- On the final Operations bundle, the current-folder counter also passed 5/5
  unit and 10/10 desktop/mobile browser tests. Fresh screenshots were inspected.
- An additional repository-wide source-layout invariant check was **5/7**, not
  green. Its unchanged baseline assertions omit the previously added
  source-qualified portal ingress route and expect an exact thumbnail-runbook
  sentence that is absent. The script, Client entrypoint and thumbnail runbook
  are unchanged from the preceding checkpoint. Record and resolve those release
  follow-ups separately; do not claim the whole repository gate passed or alter
  thumbnail behavior as part of this invitation increment.

Keep these gates separate. Passing authority tests alone does not prove that a
client can submit, staff can approve, or a recipient can safely accept.
No production migration, invitation, email, source activation, deployment or
push was performed. Coordinated release review and the broader acceptance map
remain open.
