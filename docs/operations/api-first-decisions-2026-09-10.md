# API-first architecture — recorded decisions and remaining confirmations

Recorded September 10, 2026 from the owner's answers to the [September 9 audit](operations-api-first-system-audit-2026-09-09.md).

This is a design addendum, not a claim that the replacement architecture is implemented, deployed or live-verified. It preserves the audit's findings and replaces recommendations that the owner changed. Recording these answers did not change application code, production settings, credentials or the existing goal status. The separately approved PR47 merge is recorded below.

**Later September 10 confirmation:** The owner approved editing established projects in either application with conflict-aware synchronization, accepted the recommended billing/history and personal-hide behavior, confirmed the ten-minute alert interpretation, explicitly approved merging PR47, and confirmed the Incoming TrueNAS task is paused. These design questions are resolved; deployment and pickup acceptance gates still remain.

**Implementation authorized:** The owner subsequently asked to continue the migration and retained work with generic open-source PA behavior and preservation of existing Ops client public links. The [current implementation objective and task register](api-first-migration-plan.md) records this scope and its release gates.

## September 22 implementation status addendum

- Operations PR [#107](https://github.com/ledgetoptechnologies/LedgeTop-Ops/pull/107)
  is open at `e2044dc4d09b9721a20d5dd4d5f271798ec1e89e`; its replacement
  full CI run is still in progress. Project Alpha PR
  [#188](https://github.com/ledgetoptechnologies/Project-Alpha/pull/188) is open
  at `cbabe57e3d2bceceb5fc724d083ea332c1864500` with all reported checks
  green. Neither PR is represented here as merged or production-deployed.
- Reconciliation review requires an administrator to select one exact PA
  finding and one exact existing Operations record. It never matches by name or
  email. The resulting mapping and native-owner claim are inactive and require
  a separate, fresh, explicitly authorized activation; reservation alone does
  not grant portal access or change Delivery/public-link state.
- Operations staging migrations 0123–0138 and the corrected reconciliation
  schedule are live in staging. The schedule ran successfully but stayed idle
  because no PA staging API-v2 connection is enabled. Joined reservation and
  activation acceptance therefore remains open, and no production client or
  managed-directory access was activated.
- Production PA remains normally editable until PR #188 is merged, deployed to
  both instances, its exact scoped application passes the cutover gates, and an
  administrator separately activates managed-directory ownership. The PR47,
  PR48 and original Incoming observations below are retained as dated history,
  not current release gates.

## 1. Decisions accepted from the owner

- **Shared customers:** Operations is the normal editor of shared client information and customer organization structure. PA offers a generic, optional read-only client-directory policy, available only when a capable client-write API connection is configured. Financial fields and issued-document snapshots remain PA-owned.
- **Project creation and editing in either app:** Staff may create and edit a project in Operations or PA. Both systems should show the corresponding project automatically; no routine manual "unlinked financial project" queue. Operations is preferred, not compulsory. Version checks and conflict review protect concurrent edits. Syncing does not by itself share a project with clients.
- **One-to-one projects:** One Operations project maps to exactly one project in one selected PA instance, with one shared name. A customer using both businesses does not cause the same project or invoice to be duplicated into both instances.
- **One client experience:** One customer login and dashboard with appropriate service sections. Drone-only clients see their drone work/data; website-only clients see their website information and review/edit requests; clients with both see both. Service requests remain available according to enrollment/availability. Enrollment does not grant another person's files or billing documents.
- **Employee review:** A division manager can run their division, create work and confirm their own records, but remains an employee whose work/compensation needs independent owner or authorized time-review-manager approval. Being a division manager does not authorize settling one's own pay.
- **Pricing:** PA owns client pricing and financial rules; Operations reflects/selects authorized presets. Client charges and employee compensation remain separate.
- **Compensation policy for everyone:** Ownership, permissions, business relationship and compensation are independent. Owners/managers may have different explicit rates; ownership must not silently force no compensation. No-automatic-compensation is an explicit selectable policy.
- **Flexible time:** Time may attach to a project/operation or represent internal/unassigned work such as event attendance. Authorized managers may enter time on someone's behalf and award a bonus. A worker does not need a PA login merely to have time or compensation records.
- **Billing allowlists:** Support multiple individually authorized billing/document recipients across customer units. Provide customer-level defaults and project/operation additions and removals. File access and financial visibility are separate permissions.
- **Public document links:** Operations reads PA's current link/status; reading a dashboard must not create or revive a revoked public link. Payments, contract actions and financial truth stay in PA.
- **Customer divisions:** Support both multiple units sharing a billing entity and divisions that are separate billing entities. Do not equate a geographical division with a billing entity. Customer units are separate from staff divisions.
- **Outages:** Operations remains usable when PA is unavailable, including beyond ten minutes. Notify the owner by email after a PA disconnection lasts more than ten minutes; this is an alert threshold, not an Operations shutdown timer. Stale PA-dependent actions must remain bounded as described below.
- **AlphaLedger:** The separate product is deprecated and merged into PA. Remove the obsolete separate integration target from this plan; preserve migrated financial records and reusable functionality.
- **Notifications:** Keep functionality PA does not provide. Where PA and Ops duplicate a financial notification, PA owns it and the duplicate Ops sender is retired. A deduplicated portal activity item is distinct from another receipt email.
- **Immediate Incoming priority:** Complete the safe, simple rclone pickup path for the waiting client upload without waiting for the entire architecture replacement.
- **One coordinated cutover and rollback:** The previously proposed rehearsal/rollback approach is accepted; no indefinite competing-authority transition.
- **Website and Hermes work in this phase:** Incorporate service-driven website workflows/reporting and the generic scoped agent API into the same overall phase. Design their data/permission boundaries early and implement their consumers after the foundation; do not repeatedly rebuild the foundation later.
- **PA deployment handoff:** Once verified PA updates are published and ready, stop at the deployment handoff. The owner updates both production instances and signs in for acceptance. Do not assume a local commit means production was updated.

## 2. Important implementation rules recommended by the audit

These are proposed guardrails derived from the answers, not additional business decisions silently attributed to the owner.

### Managed customer directory and API keys

- Enabling external management requires an enabled, usable service principal/token with the required client-write scopes, plus explicit administrator confirmation. PA remains generic and fully usable standalone when external management is off.
- Associate the management policy with a stable external application identity, not a particular rotating token string. Rotating keys must not change ownership.
- If the final capable token expires or is revoked, show an actionable disconnected/read-only state. **Do not automatically unlock PA editing.** Otherwise an expired key silently creates two customer authorities. An administrator can explicitly restore local management after resolving pending changes.
- Enforce the policy on the server for forms, imports, onboarding, jobs and other mutation paths, not just by hiding buttons. Keep permission for client writes separate from settings, staff administration, payments and unrestricted future scopes.

### Projects: automatic linking without automatic disclosure

- Staff creation in either system automatically creates the counterpart using a permanent mapping and an idempotent command. PA-first projects inherit their originating PA instance. Operations-first creation needs a billing-business choice when the service/customer context is ambiguous.
- During an outage, show "Sync pending" rather than requiring the user to create another record. Retry with the same command identity; after an uncertain response, look up the original result before creating anything again.
- Client-created proposals remain proposals until staff acceptance. Acceptance creates or links the PA counterpart automatically; proposed work must not create invoices or payable work just by existing.
- One shared name does not mean financial-document contents become live editable snapshots. Renaming a project preserves its IDs, invoices, contracts, history and historical document text.
- The owner explicitly permits both creation and subsequent shared-field editing in both places. Use version checks and a review item for conflicting changes, never silent last-write-wins. Ordinary non-conflicting synchronization remains automatic; do not introduce a manual intake queue for every PA-created project.
- Project synchronization alone is not a delivery grant. An approved project can be visible to authorized participants without exposing internal notes, every model/file, or every financial document. A project with no authorized portal participants stays internal.
- Keep established projects and financial links intact. Completion/cancellation/archive are distinct from deletion. Client hiding is not deletion, cancellation or revocation; personal-hide is the confirmed default.

### Time, work review and compensation

- Use clear stages: **record work → submit/attest → independent review → eligible financial processing → settlement**. A division manager's self-confirmation is submission/attestation, not final pay approval. Recording or approving time does not automatically invoice the client or pay the worker.
- Internal/general time uses a real work category without requiring a fake client/project. Billability and compensation are independent, and an internal entry cannot accidentally become a client invoice line.
- Store beneficiary, actual actor, work date, category, optional project/operation, rule version, revision and reason. Manager-entered time must say who entered it for whom. Record edits and approval decisions; require re-review of material changes.
- Record a bonus as an explicit compensation adjustment with a reason and authorized approval, not fabricated hours. Reflect its financial processing in PA through an idempotent command. Do not infer payroll or tax treatment from these application policies.
- Preserve fixed, hourly, base-plus-overage and no-automatic-compensation policies. A fixed payment is counted once per eligible job, not once per time segment; client discounts do not silently change worker pay. PA evaluates financial rules and Operations presents versioned previews.
- Ordinary workers cannot approve themselves or alter their pay rules. The owner may review employees under delegated authority; approving an entry the owner created for another person must remain visibly attributable. An owner approving their own compensation requires an explicit exceptional policy, not an accidental admin bypass.

### Billing and organization structure

- Model customer groups, typed units and billing entities separately. A unit can have an explicit bill-to entity; a separate billing entity is not modeled only as a display label on a department. A shared customer may map to different PA customer IDs without merging separate financial ledgers.
- Recommended recipient evaluation: active identity and customer membership, permitted billing entity, inherited allowlist plus explicit local additions, then local exclusions and global revocation. Show effective access and its source before saving. Global revocation cannot be overridden by a project addition.
- Project/operation overrides cannot accidentally expose an invoice that spans other unauthorized work. Resolve authorization at the complete document level, not by hiding some invoice lines. A mixed-scope document needs an authorized document recipient decision or separate documents.
- Confirmed history policy: apply revocations immediately, but default new grants to future documents and require explicit preview/confirmation to expose historical documents. Portal deny rules cannot recall an already copied public PA bearer link. PA remains responsible for its own link revocation.

### Outages and notifications

- Confirmed interpretation: **ten minutes is an alert threshold, not an Operations shutdown timer**. Native Operations jobs, uploads, service requests and time capture continue beyond it. Per-instance queues retain pending sync work safely.
- Track each PA instance separately. Start a deduplicated incident after failed health/reconciliation attempts, email once after ten continuous minutes, and record recovery. Distinguish transport problems from rejected credentials or incompatible API versions. Do not email on every retry.
- Keep last-known financial summaries clearly timestamped, never turn unknown balances into zero. Use ten minutes as the proposed maximum cached age for PA-dependent actions, with earlier disabling when an actual denial/revocation is observed. Offline data must never expand grants or establish payment success.
- A failed integration API does not prove every existing PA public link is down. Link availability must reflect the relevant evidence; do not invalidate good links or invent successful availability from stale state.
- Inventory notification producers by event, recipient and channel. Historical imports seed state silently. Preserve upload-received emails, website reviews and other unique workflows; do not duplicate PA receipts or financial-email retries.

## 3. Revised work sequence and completion gates

1. **Incoming maintenance track, independent of API cutover.** Recheck the existing local promotion/browsing code and focused tests, resolve release permission, coordinate the ready-only TrueNAS path and retention, then release a controlled upload. Verify the exact waiting source still exists before promising recovery. Do not add a server agent.
2. **Contract and migration design.** Lock canonical identities, customer/unit/billing mappings, service enrollment, staff scopes, project linkage, time review, document recipients, managed-policy lifecycle and API compatibility. Include website and Hermes permissions now.
3. **Generic PA APIs and safety.** Add scoped writes, stable external identities, idempotency/version checks, managed-directory policy, external-worker/time interfaces, safe project retention and financial read/action interfaces. Keep standalone PA behavior generic. Do not let previously read-oriented legacy keys silently acquire new write powers.
4. **Operations workflows and adapters.** Implement local staff admission, canonical clients, two-origin project creation, employee/general time and review, durable PA synchronization, billing allowlists, outage alerts and deduplicated notifications. Replace the old PA-driven staff admission reconciler so it cannot undo Ops-managed access.
5. **Portal, website and agent consumers within this phase.** Unified service-specific portal sections, explicit finance visibility, existing sharing/history, website review/edit requests and monthly reporting, and a scoped Hermes API with audit attribution. No unrestricted agent token or unsolicited client launch emails.
6. **Migration and joined testing.** Exercise both PA instances, a shared customer, one-service customers, revoked people, Ops-only employees, billing overrides, owner compensation, lost-response recovery, project renames and preserved public download/Viewer grants. Preserve the existing Viewer contract; its repository remains read-only to this task.
7. **Publish verified updates and stop for the owner.** Provide exact PA revision/build and any migration prerequisites. The owner updates both instances and signs in; no assumption that either is already running the replacement.
8. **One coordinated authority switch.** Rehearse private backups/restore, freeze only affected writes, reconcile mappings, fence old writers, switch ownership, run controlled acceptance, and retire custom integration code/configuration while preserving records. After real new business events, use the durable ledger/fix-forward path rather than a blind historical restore.

The tracked legacy goal is still blocked and still describes the old phased PA-owned direction. This addendum is the updated scope record; it does not falsely mark that goal complete or claim its objective/status has been changed. Implementation acceptance must use these revised decisions together with the audit's unresolved findings.

## 4. Incoming release evidence and limits

- At the start of this follow-up, Operations checkout HEAD was `ba56d72a41cc1bfde2836c0e1ea75929f107a675`; pre-existing local modifications and private temporary artifacts were preserved.
- The [September 9 checkpoint](client-portal-checkpoint-2026-09-09.md) records passing exact-head CI, additive Client D1 migration 0213, and draft PR47. It records a rejected merge attempt and the requirement for explicit permission to merge that Operations PR. Those are dated observations, not a fresh deployment check.
- Fresh read-only GitHub verification in this follow-up confirms [Operations PR47](https://github.com/ledgetoptechnologies/LedgeTop-Ops/pull/47) remains open, draft and mergeable at exactly `ba56d72a41cc1bfde2836c0e1ea75929f107a675`. This does not authorize a merge or verify deployed configuration.
- The focused local release recheck found the publishing gate still false in `apps/operations/wrangler.jsonc:27`; completion, scheduled dispatch and staff ready-object reads are gated in the implementation. No new code gap was established by that limited review. It is not whole-system certification.
- Fresh focused verification: from `apps/operations`, `npm exec -- vitest run --config vitest.config.ts test/incoming-rclone-promotion.test.ts test/incoming-rclone-outbox.test.ts test/incoming-rclone-read.test.ts test/incoming-staff-upload-routes.test.ts --reporter=dot` completed with exit code 0: **4 files, 39 tests passed**, 58.67 seconds. The initial sandbox attempt failed before tests because the configuration loader was denied an ancestor-directory read; the approved outside-sandbox run used isolated test resources, not production. Existing dependency sourcemap and runtime warnings did not fail the tests. This is not a fresh full-suite, browser or live pickup acceptance result.
- The [Incoming runbook](../truenas/incoming-rclone.md) specifies a disabled-by-default publication gate and TrueNAS `ready/` pickup. The last supplied screenshot selected bucket root `/` for hourly PULL/MOVE. The owner subsequently confirmed the task is now paused; a `ready/` selection and re-enable have not been confirmed.
- Source identity, recipient authority and bounded basic checks are still required. Basic checks are not a malware verdict. Never delete the user's previously downloaded opaque objects: one may be the original waiting upload.
- If MOVE has already removed the only R2 source, changing application status cannot recover it. Locate and verify the existing local copy with the owner rather than manufacturing a verification or pickup receipt.
- Live retention policy, exact waiting-object availability and an end-to-end server pickup remain acceptance gates. The PR merge below is confirmed; Cloudflare deployment and a successful dataset download are not established by it.

### Approved merge outcome

- Following explicit approval, PR47 was marked ready and merged using `--match-head-commit ba56d72a41cc1bfde2836c0e1ea75929f107a675`, without an administrator bypass or branch deletion.
- GitHub readback confirms `MERGED` at `2026-09-10T22:21:05Z`, merge commit `6752ee2cf8f69bdb8221f7b02a6a68962eb3f28d` on `LedgeTop-Ops/main`. All ten checks on the approved PR head had succeeded before merge.
- Post-merge [CI run 34537003386](https://github.com/ledgetoptechnologies/LedgeTop-Ops/actions/runs/34537003386) was initially in progress. Subsequent GitHub readback confirmed `completed` / `success`, with all ten jobs successful. This does not by itself establish the exact active Cloudflare deployment.
- The merged code retains the disabled Incoming publication gate. This merge does not include the separate uncommitted reminder/configuration edits or these local decision documents. No PA update, credential change, storage-policy change or TrueNAS mutation was performed.

## 5. Browser observation in this follow-up

- Both LTDS and LTT tabs were present in the session browser. Each displayed its Dashboard, with no visible password form or "Session expired" message during inspection.
- This is confirmation of the visible browser state only, not proof that synchronization, current portal provisioning or the future APIs are healthy. No PA settings were saved, credentials read, connection changed or sync action triggered.

### Incoming object and retention follow-up

- Cloudflare's `ltds-incoming` Objects view was empty, consistent with its overview reporting zero objects. No real upload was downloaded, altered or deleted during inspection. Absence is not proof of server receipt.
- Live lifecycle settings showed the existing multipart-abort rule and 14-day `quarantine/` deletion rule, but no `ready/` expiration rule. The owner explicitly chose **leave retention unchanged for now**. Do not add the proposed `ready/` deletion rule; preserve existing bucket policy and application access expiry. Uncollected ready bytes do not acquire a physical-expiration fallback through this decision.
- The exact previously reported local network-drive path could not be accessed in this session. The owner asked whether to reverse the pull to push. Guidance: keep the task paused; do not reverse MOVE, which would remove local source files after upload. First confirm the affected uploader's local original and size. Any needed recovery should be an exact, separately authorized one-time COPY preserving the local original, with identity/version checks before re-admitting it to the workflow.
- The owner subsequently confirms the opaque `object` file exists at about 872 MB. The live Ops upload detail identifies the expected ZIP, displays 852 MB, and states its private object is absent from Incoming. This session still cannot read the local file. Approximate size is not checksum/byte-count proof: preserve the original and inspect a separate copy as a ZIP before deciding whether any re-upload is needed. No status was marked verified/downloaded and no bucket object was recreated.

## 6. Confirmed answers and remaining operational gates

### Latest owner confirmations (supersede earlier operational status)

- The owner updated and resumed the goal with the full API-first architecture;
  earlier references here to a blocked legacy goal are historical only.
- The affected uploader's ZIP was recovered and verified on the network drive with explicit
  permission. The owner confirmed it works and authorized removal of only the
  original opaque file and its empty upload-specific directories. No fabricated
  verification or server receipt was written to Operations.
- TrueNAS now selects `ready/` and the owner resumed its hourly PULL/MOVE task.
  Retention remains unchanged. New tests must account for hourly pickup.
- PR48 was explicitly approved and merged at `63425fc9758bb37037eb14ba181eb8f586e21636`
  after all ten exact-head checks passed. Cloudflare activation still needs
  deployment readback and live workflow acceptance.
- For the duration of this goal, the owner authorizes merging tested Ops
  changes to `main`. Required checks and protections still apply. PA work stays
  local until an owner review handoff **before merge/release**; the owner uses
  PA in production and will help check and deploy both instances.
- The [migration register](api-first-migration-plan.md) contains current test,
  release and remaining-gate evidence. Older observations below are retained
  as history, not instructions to pause or reverse the now-resumed TrueNAS task.

- **After a project exists, should its shared name/dates/status be editable in both PA and Operations, or only Operations?**
  - **Confirmed:** Editable in either, with version-aware synchronization and conflict review. No silent last-write-wins. PA-only financial fields remain PA-owned.
- **Should changing a billing default affect existing documents, and should client project hiding be personal?**
  - **Confirmed recommendation:** Keep client hiding personal by default. Apply membership revocations immediately; apply new document-access grants to future documents by default, with an explicit preview/confirmation before granting access to historical documents. Project/operation removals immediately reduce portal access within their scope, subject to PA public-link limitations.
- **Does the ten-minute outage rule mean an email after ten minutes while native Operations continues?**
  - **Confirmed:** Yes. Do not shut off uploads/jobs/time tracking because PA is unavailable. Use clearly stale financial summaries and disable actions when fresh authority or PA availability cannot be established.
- **May Operations PR47 be merged into `LedgeTop-Ops/main`, and is the Incoming TrueNAS task paused or already restricted to `ready/`?**
  - **Confirmed:** Explicit merge approval was given and the merge completed. The owner reports the Incoming TrueNAS task is paused.
  - **Remaining operational gates:** Confirm the deployed revision, unchanged retention and exclusive publisher, exact waiting-upload source, and controlled end-to-end publication/read acceptance. Change the paused task's remote selection to `ready/`, preserving its destination and hourly PULL/MOVE schedule; verify it before resuming pickup. Keep publication disabled until the coordinated activation checks pass. No new retention rule is authorized. These are verification steps, not unanswered architecture questions.
