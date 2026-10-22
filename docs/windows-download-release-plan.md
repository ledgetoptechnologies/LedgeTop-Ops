# Windows files app: installer and release plan

Decision record, 2026-10-22. This is a release plan, not a published installer.
The existing .NET transfer core and human portal adapter remain reusable by
Claude's desktop UI. Do not make a signing purchase, publish binaries or register
a provider on a real user's folders as part of this source-only phase.

## Distribution decision

### Ownership and address checkpoint, 2026-10-22

Ops and each PA manage employees independently; only client profiles synchronize
to selected PA destinations. The Windows gateway/read/queue routes must continue
to require current native Ops admission and an explicit file grant, including
when a legacy staff row remains active or PA sends a grant for the same email.
The updated backend draft removes the old PA staff writers and automatic
Access-group rewriting without deleting existing staff or widening membership.

`ledgetop.app` and `portal.ledgetop.app` are separate migration candidates, not
active Windows endpoint replacements. Keep the currently reviewed fixed Ops,
portal and gateway origins until exact host, audience, CSRF, redirect and native
delivery acceptance is complete. Never teach the desktop to follow a redirect
with its human token to accommodate the domain move.

The backend draft includes the reviewed main/ready-PR CI policy and matches it
in the Windows/gateway workflows. This does not enable Engineering Hub execution
or satisfy required hosted checks. The corresponding CI policy release remains
separate from employee/client delivery activation.

### Installer target

Use a per-user, signed MSIX desktop package as the first distribution candidate.
Keep the private GitHub source repository private. Publish signed binary artifacts
through a dedicated HTTPS download endpoint after release approval. A GitHub
source login must not be needed to install or update the app. Use separate pilot
and stable identities/channels so a staging app cannot replace production state.

MSIX supports desktop applications; it does not require converting the transfer
engine into a UWP application. Evaluate the UI packaging on a clean Windows 11
VM before committing to MSIX. If endpoint policy prevents MSIX, retain an MSI
fallback with the same signed publisher and data-protection rules. Neither
installer should require SMB credentials, bucket keys or a machine-wide service.
[Microsoft desktop packaging model](https://learn.microsoft.com/en-us/windows/msix/desktop/desktop-to-uwp-behind-the-scenes)

## Build and signing pipeline

1. Pin the reviewed SDK and dependency locks. Build self-contained Windows x64
   first; add arm64 only with native-runner acceptance. Produce an SBOM and retain
   the exact commit, runtime version, dependency hashes and build log.
2. Bundle a reviewed, hash-pinned official cloudflared Windows binary in the
   protected installation directory. Include its license/required notices.
   The app already checks the binary hash before each execution. Updating it
   requires a reviewed application release, never a PATH lookup or an unsigned
   runtime download. Validate supported human login/token behavior on that exact
   binary, rather than relying on master-branch documentation.
3. Choose the business's durable publisher identity and trusted code-signing
   mechanism before production packaging. Use managed signing or an existing
   trusted certificate; keep signing keys outside source, build output and the
   user's ordinary file storage. No certificate enrollment is completed yet.
4. Sign the package, timestamp using the signing provider's supported timestamp
   service, and independently verify trust, signature, publisher/manifest match
   and artifact SHA256 on a clean Windows machine. Reject untrusted, modified,
   mismatched-publisher and missing-signature packages.
5. Publish immutable versioned artifacts plus an App Installer descriptor only
   after tests and approval. The descriptor and all artifacts use fixed HTTPS
   origins; no repository token or end-user authentication secret is embedded.

Windows requires a trusted signature for installable MSIX packages. Development
self-signing can be isolated to a disposable test VM; do not ask clients to
disable signature enforcement or import a development root certificate.
[Microsoft MSIX signing](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview),
[cloudflared license](https://github.com/cloudflare/cloudflared/blob/master/LICENSE)

### Qualified vendor candidate

On 2026-10-22, the official Windows x64 cloudflared `2026.10.3` asset
(`cloudflared-windows-amd64.exe`, 55,329,336 bytes) matched GitHub's published
SHA256 `76b2805253d0d6ffacb092a7acfbee99e7af6917835c0c5410e23f3ef5052da2`.
Windows Authenticode verified publisher Cloudflare, Inc. Root independently
rechecked the local hash and signature. Actual version/help execution confirmed
the login `--app`/`--quiet` and token `--app` flags used by the adapter.

Retain this exact asset hash when evaluating packaging; GitHub marks the release
mutable, so a version tag alone is insufficient. The binary was qualified in an
owned temporary directory and was not installed globally. No login, token-cache
read or real authenticated desktop session was performed. Bundled-binary and
clean-machine runtime qualification remain open.
[Official release](https://github.com/cloudflare/cloudflared/releases/tag/2026.10.3)

## Update, rollback and uninstall acceptance

Use App Installer's supported update mechanism rather than a custom privileged
updater. Pilot the chosen launch/background settings. An update must pause and
checkpoint transfers before replacing binaries, then renew human authorization
and resume only when logical file ID, remote version, length and SHA256 match.
Installing a newer build must never overwrite unrelated local files or restore
revoked access. Test updates during a partial transfer and with no network.

Do not enable arbitrary downgrade through the update descriptor. Rollback is a
new signed release carrying the last known-good behavior with a forward package
version. Test schema compatibility for queue/partial state before publication.
Uninstall removes application-owned registration and executable state while
preserving completed user downloads. Offer a separate explicit choice for owned
partials; never recursively clean an arbitrary user-selected destination.
[Microsoft App Installer update settings](https://learn.microsoft.com/en-us/windows/msix/app-installer/update-settings)

## Explorer online-only and offline files

Use Windows Cloud Files APIs for a later desktop provider, not fake sparse files
that look downloaded but contain missing content. Register a per-user sync root;
map provider identity to the signed-in human and opaque remote version. Hydration
must obtain fresh Ops/portal authorization and use the same verified range core.
Implement offline pinning, cancellation, placeholder repair, identity switching,
source changes, low disk, restart and uninstall recovery before offering it.
Downloaded bytes cannot be remotely recalled; revocation stops future reads.

The initial product is read-only remote delivery. A user editing a downloaded
copy must not silently overwrite server content. Writable employee sync still
needs a proven conditional-write contract that closes PR206's preserved-mtime
overwrite failure. Client R2 remains read-only.
[Microsoft Cloud Files platform](https://learn.microsoft.com/en-us/windows/win32/cfapi/build-a-cloud-file-sync-engine)

## Release gates still open

- Real staging employee and client sign-in, identity switching and per-user
  provisioning/revocation against both sources; no shared machine login.
- Large-file performance and interrupted resume, including files above 30 GB.
- R2 checksum coverage/backfill and employee gateway enrollment/temporary-storage
  sizing, using staging without touching TrueNAS.
- Live qualification of Claude's implemented unified browsing and transfer queue;
  its synthetic WPF acceptance is passing, not installed-user acceptance.
- Clean-machine signed install/update/rollback/uninstall acceptance.
- Separate Cloud Files placeholder/offline qualification before advertising it.

GitHub CI runs on main and pull requests. Feature-branch Engineering Hub tests
need an enrolled Ops runner; shared planning documents alone do not execute them.
