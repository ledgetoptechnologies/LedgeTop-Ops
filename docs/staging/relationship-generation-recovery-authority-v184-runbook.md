# Relationship-generation recovery authority (v184)

This staging-only authority window is fixed to staff `staff-beau-koltz`, client `614ed50f-8800-4ab3-aa69-009d8e5cefa9`, organization `staging-directory-acceptance-ff089045-ea88-4c34-90a5-2ef898b9142f`, source `project-alpha:staging`, relationship version 2, and terminal predecessor `74929834-c068-480b-af77-4af3cd4aa0e1`.

It does not alter any reviewed 183-chain authority API. It requires the exact 184-file migration ledger and complete actor grant/history snapshot. Provision changes exactly six resource-scoped grants: client and organization `directory.profile.edit`, `directory.identity.link`, and `directory.enrollment.manage`. Each must be absent with its proposed ID unused, or be the single exact inactive retained resource row. The current expected staging state has four absent resource grants (all three client grants and organization enrollment) and two inactive organization grants; the compiler fails closed if readback differs. Historic business-area grants are separate rows and are never reclassified or reused. The existing global `directory.profile.view` grant is selected for both resources but is never changed. Existing `portal_access.manage` authority is unrelated and remains untouched.

Provision and revoke are distinct atomic D1 batches with fresh approvals and receipts. Revoke requires the exact saved provision artifact, deactivates only its six grant IDs, marks only that provision approval revoked, and preserves every grant and history row. Expiry does not clean up authority automatically.

Paired cleanup must complete before either selected record, the canonical relationship, or the terminal predecessor/source identity changes. Revoke deliberately rechecks those exact versioned snapshots; later record changes are not a reason to weaken the cleanup guard or edit the saved artifact.

Before live use, independently review the generated artifact, exact current record versions, canonical relationship, terminal predecessor, source configuration, enrollments/mappings, complete grant history, absence of denies, and zero pending or leased Directory/relationship/recovery work. Keep recovery default-off until the reviewed runtime and migration are deployed together.

```powershell
node scripts/staging-relationship-generation-recovery-authority-v184-window.mjs prepare --config <private-config>
node scripts/staging-relationship-generation-recovery-authority-v184-window.mjs apply --config <private-config>
node scripts/staging-relationship-generation-recovery-authority-v184-window.mjs close --config <private-config> --artifact <private-provision.json>
node scripts/staging-relationship-generation-recovery-authority-v184-window.mjs reconcile --config <private-config> --artifact <private-phase.json>
```

`prepare` is read-only. `apply` saves private evidence before mutation. If an apply response is uncertain, do not issue new IDs or retry blindly; reconcile the immutable approval and receipt directly before proceeding. Close only after the recovery command is acknowledged or terminal and all normal and recovery queues are drained. Verify all six grants inactive, the global view and portal-access grants unchanged, the provision approval revoked, the separate revoke receipt present, and no pending migration.

This packet grants authority only. It does not enable the feature, create a review, authorize recovery, dispatch a command, alter canonical relationship/history, or prove Project Alpha acceptance.
