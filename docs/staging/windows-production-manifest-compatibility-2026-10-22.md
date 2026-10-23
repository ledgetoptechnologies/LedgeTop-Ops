# PR250 manifest compatibility check

Source-only check from `3389d192`; no deployment or hosted CI restart.

`77eb072a` root `package.json` has LF-normalized SHA-256
`f8eb91b8e39b62df7d7a13b6474f96297e05110c443899c1b109fa2a0062a1d0`.
Commit `730e3d18` changes only these root manifest entries:

- Adds `scripts/windows-files-staging-preflight.test.mjs` to `scripts.test`.
- Adds `staging:windows-files:preflight`: `node scripts/windows-files-staging-preflight.mjs --read-only`.
- Adds `staging:windows-files:preflight:test`: `node --test scripts/windows-files-staging-preflight.test.mjs`.

The resulting complete manifest SHA-256 is
`c2c9b2f65bf33250158efa14ee67ac20432518ce4b33f20b45c23042ca3f2ebf`.
No root lockfile, app manifest/lockfile, dependency or build command differs from
`77eb072a`. The production guard now recognizes precisely this additional whole
manifest hash, retaining the previous exact hash alias. It does not filter script
names or accept arbitrary manifest changes.

This does **not** authorize deploying PR250 with the historical backend release
profile. The real branch frontend fingerprint is
`060d8436361663399d3320268b98ae78ac418696795c64f1908e64235efe1258`,
and `checkMode('backend', fingerprint)` still rejects it. The protected shared
inputs include a 29-line insertion into
`operations-portal-native-delivery-authority.ts` and the new 68-line
`windows-queue-reference.ts`. Neither receives a digest alias. The test reconstructs
main77's authority source with exact before/after hashes and removes only the new
queue file in a temporary test copy; that copy reproduces the complete frozen
fingerprint `636f86a871ab4a8d2e99d8b71471397ae9c473d947231385e56ed4f87ba7994c`.
The source mains, production profile, retained assets policy and deployment-mode
checks are unchanged.

Validation: `node --test scripts/production-deploy.test.mjs` passes 40/40 locally.
Tests cover both exact manifests with LF and CRLF, altered Viewer/build/staging
commands, extra test/script/dependency entries, wrong paths, the complete baseline
reconstruction and rejection of the real branch's shared-source drift.
