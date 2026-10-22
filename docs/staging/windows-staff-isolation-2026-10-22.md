# Windows delivery: independent employee ownership

This checkpoint integrates Ops-owned employee admission into draft PR235.
Each PA continues to manage its own people. Only client profiles synchronize to
their selected PA destinations. No production deployment, live grants, database
migrations, TrueNAS/NAS access or writable sync was performed.

## Source and regression scope

The staff-isolation source is cherry-picked as `8313a9d7`. It removes PA staff
projection writers, legacy employee entitlement mutations and automatic Access
group rewriting while preserving existing staff rows and bindings. Native
Windows authorization still requires active current Ops admission and explicit
root/file authority; PA identity or a matching email grants no file access.

The joined employee test now uses the complete Ops schema through0224. It keeps
the legacy staff row active, disables native admission, and checks denial of
roots, entries, manifests, previously issued byte handles and all queue routes.
Actual primary and secondary PA entitlement handlers then receive matching-user
grant/revoke events. Admission stays disabled, the gateway is never called, and
no new content audit is created. Existing re-enable/lifecycle checks remain.

## Verification

- Focused Ops authentication/routes/queue/staging/provisioning-policy:97/97.
- Real D1 joined authorization, authority and provisioning:37/37;256.05s total.
- Complete Ops224+Client236 staff/client isolation acceptance:4/4 with240s
  schema-preparation allowance;111.71s test time on the diagnostic run.
- Operations TypeScript check passed.
- Windows .NET10.0.402 Release core:63/63 synthetic transfer groups.
- Desktop draft0638d631 AppTests:15/15 synthetic WPF groups, rendered output
  inspected. Real human sign-in and remote transfer were not exercised.
- Main/ready-PR workflow policy and Viewer boundaries:16/16.

The original standalone acceptance run exceeded its120s setup hook. The config
now permits240s only for full-schema preparation on Windows; individual test
commands remain120s and the outer wrapper remains300s. The normal wrapper
`node scripts/independent-staff-client-acceptance.mjs` subsequently passed4/4
in99.88s total (98.16s tests), with no CLI timeout override.

The exact pinned SDK was restored to a private cache from Microsoft's official
10.0 release metadata; the ZIP SHA512 matched before extraction/execution. No
system SDK, certificate trust or signing configuration was changed. Claude also
reported the earlier private SDK cache path; no SDK-version substitution was
necessary.

## Fresh read-only staging observation

- Ops version231fead7-433e-4015-847e-ea9ebda35894:221 ledger entries through0221,
  Windows0222/0223/0224 pending;2403 schema objects;0 foreign-key violations.
- Client version6b9f1ff4-ce41-493e-a922-25081c2b67f4:153 ledger entries through0234,
  Windows0235/0236 pending;1158 schema objects;0 foreign-key violations.
- Exact staging binding metadata was checked before schema reads. No migrations
  were applied. Observation is not atomic and does not prove historical SQL
  equality; `canonicalBaselineVerified:false` remains correct.

Engineering Hub still reports autonomy unconfigured/disabled, no runs, and
Windows taskceff196b-0f59-420a-b21a-ec89c098ba60 unclaimed. Existing reviewed-image
pilot approval is not an Ops source-build execution receipt. Main CI policy and
Lori's repair remain separately tracked.

## Remaining delivery gates

Establish the reviewed EH execution path, enrollment and private TLS gateway;
mount and migrate the exact staging candidate with restoration evidence; prove
real human employee and client sign-in, desktop-to-server/R2 interruption/resume,
identity switch and revocation. Qualify existing/multipart R2 checksum coverage,
real30GB+ transfers and source snapshot/resource behavior. Finish signed
clean-machine installation/update/rollback/uninstall and Cloud Files
hydration/offline-pinning qualification. `ledgetop.app` is a separate unactivated
domain candidate; the desktop must not forward credentials through redirects.
