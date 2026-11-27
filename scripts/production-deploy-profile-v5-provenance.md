# Canonical installed production profile v5

This profile records the installed state after Operations main `331791ed` was
released through the reviewed `ops-staff-directory-entrypoint-v1` exception. Its
canonical JSON SHA-256 is
`d24694b5f028b065e6416be179166f92b65874d3e4ac8f79677d904e9a6362b7`
(`scripts/production-deploy-profile-v5.json`).

It was derived offline from canonical installed profile v4
(`2ef0f21be881bbe1567e4ea941255ea1f6e1be9a339c1f854174c5ac334a10fd`), plus the
exact delta that the retained executor verified against v4 before and after
activation:

- Operations `script.named_handlers` gains one class, `StaffDirectory`, with
  exactly `getPilotDeviceAuthority`, `isActiveStaff` and `resolvePilotUsername`.
- The profile label is `canonical-installed-v5-ops-staff-directory-offline`.

Everything else is unchanged from v4: top-level handlers, every other class and
handler, bindings, secret names, runtime, settings, crons, scalar names and digests,
asset associations and Sync.

No live capture was read to build v5. The repository has no read-only
capture-and-derive script for installed profiles; v4 itself was compiled from
release receipts and a private capture. Two facts support v5:

- The executor checked the now-active Operations version
  (`01602cf8-6600-4d62-9189-13b1e5f6dd00`) against v4 plus exactly this class,
  including scalar digests and asset association, before reporting success.
- The Client release (`a4e70c5a-8001-4053-bc1e-0021aaed4b1f`) passed its
  post-activation check under strict v4.

Before the first v5 release, re-run that release's own full installation check
under the v5 preflight mode. Any drift refuses.

Select it with the ordinary preflight mode
`ordinary-frontend-preserve-installed-canonical-v5` and the profile from
`readCanonicalInstalledProfileV5()`. Under v5, later Operations and Client releases
need no StaffDirectory contract; that contract stays limited to v4.

v4 stays reviewed for rollback reasoning about versions installed before the
StaffDirectory release. The tracked `production-deploy-profile.json` remains v4.
The automatic backend lane and the installed-schema preservation policy stay pinned
to v4; extending them to v5 needs its own reviewed change.

This profile authorizes no migration, feature activation, staff cutover, access
grant or credential. It does not establish release readiness.
