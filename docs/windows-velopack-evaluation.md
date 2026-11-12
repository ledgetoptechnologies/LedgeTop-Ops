# Velopack: evaluated alternative to the NSIS installer and custom updater

**Status:** evaluated alternative, not a migration. Nothing here is adopted, packaged, installed or published. Choosing it needs Codex's independent review and Beau's decision.

**Evidence:**
- Local spike on branch `claude/windows-velopack-spike`, commit `8a97b359`, behind `-p:LedgeTopVelopackSpike=true`. A packaged build refuses that flag.
- Velopack 1.2.161 is MIT-licensed and has no dependencies. It is NuGet repository-signed, not author-signed. The nupkg has SHA-256 `d57275692b299751a12ee3e18283b5f7fe3e55339f96b1623345da095dc484ed` (642,849 bytes).
- `vpk pack` built the self-contained 169 MB publish in 4.9 s. It produced a full nupkg (74.9 MB), Setup.exe (82.4 MB), a portable zip, `RELEASES` and `releases.spike.json`, with per-asset SHA-256 and SHA-1. Nothing was signed, run or installed.

## What it would replace, and what stays ours

| Area | Today | With Velopack | Still ours |
|---|---|---|---|
| Packaging | `scripts/windows-unsigned-installer.ps1` + `Packaging/UnsignedInstaller.nsi` (makensis, payload inventory, fixed `versions\<v>` dirs) | `vpk pack`: per-user `%LocalAppData%\<packId>`, `current\` swap | Payload provenance receipts, if we keep them |
| Feed / offer | Offer JSON + PE-equivalence + strong ETag (`windows-app-release-offer.ps1`) | `releases.<channel>.json` with per-asset SHA-256 | An `IUpdateSource` for the Access-protected R2 feed, and a signed manifest if wanted (Velopack has none) |
| Apply / restart | `ExeUpdateHandoffCoordinator`, helper/IPC, `InstalledPayloadVerifier` | `UpdateManager.DownloadUpdatesAsync` / `ApplyUpdatesAndRestart` | Drain the provider before apply (as the handoff does today) |
| **Publisher trust** | WinVerifyTrust plus CN and profile-EKU pin (`WindowsAuthenticodePublisher`) | **None on Windows:** only the feed SHA-256 is checked; downgrade is blocked by default | **Keep the pin, and go beyond it.** Checking only the staged main exe and Update.exe does not bind the package's other DLLs and files, and a malicious feed can serve matching hashes. Before apply we need an independently authenticated, signed manifest that binds the exact package (hash and version), plus a full inventory and PE trust check of every executable in it. The chain-anchor pin and timestamp requirement (open findings) still apply. |
| Signing | Artifact Signing via a separate path | `vpk pack --signTemplate` / `--signParams` (signtool) on 1.2.x; native Artifact Signing only in 1.3 prerelease | Signing credentials and the profile. Watch issue #1045 (Setup.exe signing "Access is denied" under Trusted Signing). |
| Supply chain | `NuGet.Config` clears all sources; qualified local feed (pinned length, SHA and signature, retained licences) | Velopack and the vpk tool must enter that qualified feed the same way | Reviewing every Velopack upgrade |

## Current updater status (for comparison)

The existing EXE updater is source-only and unqualified, and pilot 0.5.56 disables it. Neither path has installed upgrade or rollback evidence today. All estimates here are tentative.

## NSIS → Velopack migration (the hard part)

Today's install, from `UnsignedInstaller.nsi`:
- Per-user install: `RequestExecutionLevel user` and `SetShellVarContext current`.
- Files under `%LocalAppData%\Programs\LedgeTop Files Pilot\versions\<v>`.
- Uninstall key `HKCU\...\Uninstall\LedgeTopFilesPilot`.
- Run value `HKCU\...\Run\LedgeTopFilesPilot`, owned by the app.
- Start Menu shortcut `LedgeTop Files Pilot\LedgeTop Files Pilot.lnk`.
- Installer mutex `Local\LedgeTopFilesPilotInstaller`.
- Uninstall calls `LedgeTop.Files.exe --installer-remove-connections` (sync-root cleanup) and `--installer-request-quit`.

Velopack documents no NSIS migration; the closest model is its ClickOnce guide, which it calls "relatively untested". The plan would be:
1. **Bridge release:** the last NSIS-installed version downloads and verifies the Velopack Setup.exe with the existing pin, then runs it. Setup installs to `%LocalAppData%\<packId>`.
2. **First Velopack run** (`OnAfterInstallFastCallback`, with no UI and a 30 s limit):
   - detect the NSIS install by the exact uninstall key and InstallLocation;
   - move the Run value to the new exe only if the app still owns it;
   - remove the old shortcut and version directories with the NSIS uninstaller's exact-manifest rules, implemented as a **new, separate migration cleanup**.
   - It must **not** run the NSIS uninstaller. That uninstaller asks the user for consent and calls `--installer-remove-connections`, which removes the Explorer connections, so running it cannot preserve the root.
   - It must **not** unregister or recreate the sync root: the provider ID `d8bd85d7-…`, the registration context and the saved connection profile stay in place, so existing placeholders survive.
   - The migration cleanup needs ownership checks and interruption tests (power loss or kill at each step).
3. **Uninstall** (`OnBeforeUninstallFastCallback`, 30 s, no UI): a killed hook cannot guarantee a receipt or an intact state, because Velopack kills the process mid-action when the budget runs out. So either:
   - keep destructive work out of short hooks (for example, record intent and do the ownership-checked `--installer-remove-connections` cleanup on a later normal run); or
   - make every step idempotent, with a durable journal that a later run can recover from.
4. **Identity:** keep the app's AUMID, the single-instance scope (user, session, channel) and the profile and cache paths unchanged. Only the binary location changes.

## Windows tests required before choosing

- Fresh install, upgrade from each supported NSIS version, uninstall, and reinstall over leftovers. Defender on, a live sync root, and online-only plus pinned files present.
- Update apply while Explorer, Defender or the provider holds handles in `current\`. Velopack either kills or prompts, or falls back to the old version (issue #1129 reports 35–60 s backup removal under Defender).
- Uninstall-hook timeout: confirm a slow sync-root removal ends retained and reviewable, never half-removed.
- A tampered feed: a valid SHA-256 but an unsigned or foreign-signed exe must be refused by our pin before apply.
- A feed behind Access, through our `IUpdateSource`, with an expired or absent session.
- Delta updates (issue #1008 broke bsdiff deltas in 1.2.0–1.2.110; 1.2.161 needs verifying).

## Rollback

- Velopack has no automatic rollback. "Rollback" means publishing a higher version that carries the old payload, or a deliberate downgrade with `AllowVersionDowngrade`. We should keep that off for the pilot.
- If the migration itself fails, the bridge release must leave the NSIS install untouched and working. Setup runs side by side, and the old install is removed only after the first Velopack run verifies itself.
- These bridge and rollback assumptions about keeping the root intact are untested and must be proven on Windows before they are relied on.
- The NSIS uninstaller and its exact payload inventory stay available until every pilot machine has migrated.

## Recommendation

Velopack is worth adopting **only** for packaging, the feed format and the apply/restart swap. Publisher trust, signing, the Access feed, NSIS migration and sync-root lifecycle remain ours.

Codex estimates 1–3 days for the evaluation prototype and 3–10+ days to qualify signed migration, rollback and upgrade. That is no smaller than finishing the current updater's remaining gaps (chain anchor, timestamp, single cert entry). Velopack's advantage is long-term upkeep, not near-term speed.

Suggested order: finish the pilot on the current NSIS path. Then decide on Velopack as a separate project, with the Windows tests above as its acceptance gate.
