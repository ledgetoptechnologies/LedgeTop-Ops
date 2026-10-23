# PR250 review coverage and remaining acceptance

This matrix describes actual review coverage, not approval for rollout. The
reviewed base is main `77eb072a`; the pushed candidate reviewed by Hermes is
`4142b7c68c25bf231c54a4ff3ba23b941bac2574`. Subsequent fixes are identified
separately. A partial review must not become a full Hub approval verdict.

| Slice | Independent coverage | Executed evidence and limits |
| --- | --- | --- |
| New schema diagnostics / production guard | Hermes reviewed `3389d192..4142b7c6`; local reviewer inspected immutable constituent changes | Production tooling 40/40; diagnostic/query/comparison 39/39; lexical 8/8. Hermes lacked installed Miniflare for one test, so that test was not counted as passing in his environment. |
| Employee gateway and Ops transport | Hermes read gateway core, HTTP adapter, snapshot cache, directory paging, startup/Dockerfiles; Ops employee authority/routes/transport/handles/provisioning/admin/queue; staging factories and migrations 0222/0223 | Host Python gateway 67/67; privileged nested-mount case skipped. Existing real Docker/Workerd/.NET and large-transfer receipts remain separate evidence, not a fresh Hermes transport run. |
| Windows Core, WPF lifecycle, inactive Cloud Files | Local independent reviewer read all 12 Core implementations, App profile/startup/live/backend/lifecycle and XAML bindings | One portal metadata timeout finding; fixed and independently retested 90/90 on `eaf2da8b` (integrated `059a85e3`). Earlier full transport/WPF evidence is retained; no new physical Explorer hydration or installed-user acceptance. |
| Packaging/signing/update source | Same reviewer inspected preview, channel/runtime/Go notices collectors, App Installer preview, offline signing rehearsal, projects/SDK/NuGet configuration | Unsigned previews and `.invalid` descriptors only. No blanket audit of vendor notices, trusted signature, installation, upgrade or publication proof. |
| Independent Ops staff ownership | Reviewer traced new native management read/policy/command modules and PA snapshot plus Sync incremental/Access changes | Pure policy tests 36/36. PA staff events remain durable ignored receipts; PA snapshots no longer mutate Ops staff, roles or divisions. New management helpers have no production call sites; applied native staff cutover is not claimed. |
| Client R2, publication authority and staging composition | Separate reviewer traced catalog/successor handles/routes/queue conversion, native manifest pins, successor candidate/audit, Ops chain/RPC joins, both staging wrappers and build/export policy | Client focused 267/267, Ops reader/chain/paired D1 30/30, actual offline bundles/composition 24/24, both app TypeScript checks passed. Tests include actual local RS256/JWKS and paired D1, with router/R2/RPC doubles in other fixtures. No live R2/human Access/deployment claim. |

Root independently ran the combined production/source/workflow and Windows
schema/diagnostic/runner/lexical tests: 131/131 passed on the integrated source
with the documentation wording correction. The first hosted failure was the
outdated package-manifest assertion; the second was a documentation phrase
matching the existing direct-deployment prohibition. Both guards remain intact.
Hosted CI must pass on the eventual exact final candidate; an earlier head's
Windows/gateway success does not satisfy that requirement.

Follow-up `78b5b0ea` adds an explicit sanitized missing-target guard in the
diagnostic and literal, nonrecursive owned-file cleanup guidance. Root reviewed
the patch and its focused diagnostic tests passed 31/31. No raw capture was
deleted and no new remote read was needed.

## Runtime impact

New Windows HTTP families are mounted only by the generated isolated staging
entrypoints. Production indexes and Wrangler settings do not mount them.
However, the entire PR is **not inert**: existing native delivery manifest code
gains provider/version/SHA pin validation, and the existing exported private Ops
reader gains catalog/successor methods behind its existing reader gate. PA staff
projection and Access synchronization behavior also changes as described above.
Those paths need coordinated release and recovery review before a main rollout.

## Bounds and host preparation

- Employee authorization is rechecked before upstream access and before response
  handoff. A stream already handed off can continue until EOF or its bounded
  deadline (at most 900 seconds). Physical disconnect cancellation is unqualified.
  This is a disclosed bound, not a claim of instantaneous mid-stream revocation.
- The gateway verifies immutable snapshots; the Worker validates metadata and
  framing. Final SHA-256 verification occurs in the Windows downloader. The
  Worker does not independently hash the entire stream.
- Before a staging host build, record an immutable gateway base-image digest,
  exact TLS reverse-proxy/certificate pin setup and sufficient snapshot storage.
  Source review does not establish those host facts.
- Root identity uses device/inode and fails closed on a changed mount. A remount
  requires explicit reviewed re-enrollment and new provisioning; never silently
  adopt the replacement root or its previous grants.
- Directory cursor signing has a distinct purpose prefix; a separate derived
  subkey is a possible later rotation improvement, not an identified bypass.
- Canonical staging schema/data history, the remaining six application DDL
  differences, platform objects, live users/grants and protected EH execution
  remain unresolved. Review does not enable autonomy or authorize a migration.

Hermes explicitly withheld a full Hub verdict because he did not inspect all
432 files. This matrix preserves that boundary and records complementary
reviews; it does not pretend every historical migration, test harness or notice
was independently re-audited. The exact task candidate must be updated and
reviewed after the follow-up fixes and hosted checks are complete.
