# Project Alpha service assignments as request availability

Status: implemented locally and **default off**. This is a consumer policy for
Project Alpha's existing service-assignment v1 facts. The wire contract does
not itself define request eligibility. Operations deliberately interprets an
exact active assignment as a narrowing rule for which services may be selected
for an already-authorized request.

Each Project Alpha instance remains an independent authority. Catalog items,
assignments, checkpoints, workspace ownership, and policy review are matched by
the exact `project-alpha:<source>` identifier. Equal customer, project, or
service public IDs in two instances never merge or authorize one another.

## Non-authorizing boundary

An assignment never grants `request.create`, workspace membership, project
access, file access, pricing access, delivery access, or any other authority.
Routes establish the caller's existing root or exact-project request authority
before resolving an assignment target. Readiness distinguishes
`request_not_permitted`/`project_unavailable` from `no_services_assigned`.

This policy performs no inheritance or rollup:

- a root request uses only the exact workspace root's organization or
  standalone-client assignments;
- a project request uses only the exact selected Project Alpha project;
- organization assignments do not make services available to a project;
- project assignments do not make services available at the root or to sibling
  projects; and
- department, client, parent, child, name, email, or linked-party facts are not
  inferred as request availability.

## Rollout controls

`CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED` is `false` by default. The
policy is usable only while all of these flags are exactly `true`:

- `PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED`
- `CLIENT_PORTAL_REQUEST_V2_ENABLED`
- `CLIENT_PORTAL_HIERARCHY_V2_ENABLED`
- `CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED`
- `CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED`

The Client Portal now sends the exact selected `projectId` on both catalog APIs,
selects the request context before loading services, and recognizes the
assignment readiness/error states. Keep the policy flag off until the v2 proof
expand/deploy/contract sequence and migration `0181` are complete, assignment
sync and workspace enrollment are healthy, and an authorized operator has
appended an `enabled` review for the exact source. Migration
`0181_service_assignment_request_policy_reviews.sql` seeds no reviews. An active
receiver grant, observed producer capability, or workspace enrollment alone
therefore cannot enable request filtering. Backend writes fail closed
throughout that rollout.

Reviews are immutable, sequential, and source-qualified. The latest review
must be `enabled`; suspend by appending a new `suspended` revision, never by
editing history. A secondary source can be enabled only while its portal source
authority and active authority revision exist. Suspending that authority, the
receiver grant, or the exact workspace enrollment invalidates outstanding
runtime proofs immediately without changing any other source.

The receiver grant, exact workspace enrollment, immutable source ownership,
active assignment checkpoint, complete assignment generation, active directory
checkpoint/generation, exact target, project containment, and local project
mapping must also remain current. Missing schema or proof is unavailable, not
an empty assignment list. Turning sync off makes retained assignment rows
unusable immediately. Disable the consumer-policy flag first to roll back
filtering without deleting retained facts.

## Catalog and continuation

Both the compatibility catalog and the paged catalog filter by the exact
source-qualified service ID and source version. When the policy is enabled,
there is no fallback to an unfiltered global catalog.

A paged cursor is bounded to five minutes and to the original catalog proof,
assignment evaluation time and expiry, source, workspace, actor identity,
exact local project target, Project Alpha subject, assignment checkpoint, and
directory generation. Continuation rechecks the same proof. A different actor,
workspace, root/project target, mapping, directory generation, assignment
checkpoint, effective-time boundary, enrollment, or feature state invalidates
continuation instead of returning a mixed page.

## Drafts, submission, and pricing hints

Create, save, and submit store the exact policy proof as evidence. The first
write in each atomic D1 batch rechecks account/member/project request authority,
catalog versions, receiver enrollment, source ownership, exact directory
lineage, local project mapping, assignment checkpoint, active/effective exact
assignments, and current catalog state. Enabled-policy writes cannot use a null
or legacy proof. A race rolls back the entire draft/request/notification batch
and returns `service_assignments_changed` for review.

Pricing remains non-binding and separately authorized. The pricing-hint route
checks assignments before calling the upstream provider and again after the
await, together with the stored draft and pricing authorization context. A
change suppresses the hint rather than publishing stale pricing.

Migration `0174_service_assignment_request_policy.sql` retains the historical,
primary-only v1 proof columns and adds the service-leading assignment lookup
index. Migration `0179_service_assignment_policy_proof_v2.sql` is an additive
expand step: it adds separate, strict v2 proof columns to drafts and submitted
requests. V2 requires the exact source, review ID and review revision and never
rewrites v1 evidence because v1 did not record enough information to prove a
review. Old readers remain compatible because the v1 columns stay in place.

After every old writer is drained, migration
`0180_service_assignment_policy_v1_contract.sql` prevents new or changed
non-NULL v1 values. It preserves existing v1 rows and permits unrelated updates
or explicit clearing; it does not delete or silently promote history. Applying
any of these migrations alone changes no feature flag and grants no authority.

## Migration and rollout order

For the dual-domain client rollout, preserve this order:

1. Apply `0177` (expand-only) and deploy code compatible with both domains.
2. Drain old writers, then apply `0178` (contract).
3. Apply `0179` (additive, strict, source-qualified v2 proof columns). Do not
   backfill v1 proof values.
4. Deploy the v2 writer while policy consumption remains off. Confirm new
   drafts and requests write only `service_assignment_policy_v2_json`, with a
   mandatory `reviewId` and `reviewRevision`; old readers may continue to use
   the untouched v1 column during this rolling window.
5. Drain and verify every old writer, then apply `0180`. Do not apply the
   contract trigger while a v1 writer can still receive traffic.
6. Apply `0181` (source-qualified policy review). It remains default-off because
   it creates no review rows.
7. Verify the exact source's portal authority (secondary sources only),
   receiver grant, observed capability, workspace enrollment, directory and
   assignment checkpoints.
8. Append an explicit `enabled` review with operator provenance, enable sync,
   and only then enable the consumer-policy flag for an observed rollout.

The existing v1 draft/request proof schema remains primary-source-only and
historical. V2 proof storage is source-qualified and review-bound. This slice
makes policy evaluation and continuation source-safe, but does not expose
secondary-source request submission until a source-owned request persistence
contract is deployed. Do not advertise secondary request creation before that
contract; assignment receipt or review must never be treated as general portal
access.
