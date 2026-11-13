using System.Diagnostics;
using LedgeTop.Files.Updates;
using LedgeTop.Files.Backends;
using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

/// <summary>Silent pilot-only owned-index maintenance, including the exact recorded generated V2 preview on uninstall.
/// Success is not a claim that untracked Windows registrations are absent. Local content is retained.</summary>
internal static class InstallerMaintenance
{
    internal const string CheckArgument = "--installer-check", RemoveArgument = "--installer-remove-connections";
    internal const string QuitArgument = "--installer-request-quit", AuditVersionArgument = "--installer-audit-active-version";
    internal const string LegacyRemoveArgument = "--installer-remove-legacy-preview";
    internal const string RetireLegacyArgument = "--installer-retire-legacy-preview";
    internal const string ProbeLegacyArgument = "--installer-probe-legacy-preview";
    internal const string RecoverLegacyInteractiveArgument = "--installer-recover-legacy-preview-interactive";
    internal static bool Requested(IReadOnlyList<string> arguments) => arguments.Any(value => value.StartsWith("--installer", StringComparison.OrdinalIgnoreCase));

    internal static Task<int> RunAsync((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments) =>
        CheckVersionBeforeMaintenanceAsync(compiled, arguments, InstallerVersionConflict.Check, () => RunWithQuitAsync(compiled, arguments, RequestQuitOfInstalledOwnerAsync,
            () => SingleInstance.TryOwn("pilot", () => { }), () => Task.Delay(250), 120,
            () => RunAsync(compiled, arguments, () => SingleInstance.TryOwn("pilot", () => { }), Prepare,
                remove => LegacyExplorerPreviewCleanup.RunAsync(remove, CancellationToken.None),
                interactiveRecovery: pilotOwner => LegacyExplorerPreviewCleanup.RecoverInteractivelyAsync(pilotOwner, () =>
                    System.Windows.MessageBox.Show("Setup found an old LedgeTop Files Preview. Remove its Explorer connection? Windows may remove online-only entries, and partially downloaded or locally changed files may not be preserved. Back up files you need first.\n\nChoose No to leave it in place.",
                        "LedgeTop Files Setup", System.Windows.MessageBoxButton.YesNo, System.Windows.MessageBoxImage.Warning,
                        System.Windows.MessageBoxResult.No) == System.Windows.MessageBoxResult.Yes))));

    internal static async Task<int> CheckVersionBeforeMaintenanceAsync((bool Packaged, ReleaseChannel? Channel) compiled,
        IReadOnlyList<string> arguments, Func<bool> check, Func<Task<int>> next) {
        if (compiled.Packaged && compiled.Channel == ReleaseChannel.Pilot && arguments.Count == 1 && arguments[0] is CheckArgument or AuditVersionArgument) {
            try { if (!check()) return 21; }
            catch { return 20; }
            if (arguments[0] == AuditVersionArgument) return 0;
        }
        return await next();
    }

    internal static async Task<int> RunWithQuitAsync((bool Packaged, ReleaseChannel? Channel) compiled,
        IReadOnlyList<string> arguments, Func<Task<bool>> requestQuit, Func<IDisposable?> tryOwn,
        Func<Task> delay, int attempts, Func<Task<int>> otherMaintenance)
    {
        if (arguments.Count != 1 || arguments[0] != QuitArgument) return await otherMaintenance();
        if (!compiled.Packaged || compiled.Channel != ReleaseChannel.Pilot) return 20;
        try {
            // Definite absence needs no IPC; retain thread-affine ownership through each check.
            using (var absent = tryOwn()) { if (absent is not null) return 0; }
            if (!await requestQuit()) return 10; // Includes pre-byte2/legacy owners.
            for (var attempt = 0; attempt < attempts; attempt++) {
                await delay();
                using var drained = tryOwn();
                if (drained is not null) return 0;
            }
            return 10; // Never equate acknowledgement or elapsed time with successful drain.
        } catch { return 20; }
    }

    private static async Task<bool> RequestQuitOfInstalledOwnerAsync()
    {
        // Legacy releases can lack the inventory needed to verify an exact installed peer.
        // In that case send nothing: setup remains open with manual tray Quit + Retry.
        try { return await VerifyAndRequestQuitAsync(); }
        catch { return false; }
    }

    private static async Task<bool> VerifyAndRequestQuitAsync()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        var token = deadline.Token;
        var profile = ExeUpdateWindowsTrust.Profile();
        var version = ExeUpdateWindowsTrust.ActiveVersion();
        var root = ExeUpdateWindowsTrust.Target(version);
        var markerPath = Path.Combine(root, "installer-owned.ini");
        ExeUpdateWindowsNative.NoAliases(markerPath);
        InstalledPayloadVerifier.InstalledPayloadMarker marker;
        using (var stream = new FileStream(markerPath, FileMode.Open, FileAccess.Read, FileShare.Read)) {
            if (stream.Length is <= 0 or > 16384) throw new IOException("Installed owner unavailable.");
            var bytes = new byte[(int)stream.Length]; await stream.ReadExactlyAsync(bytes, token);
            marker = InstalledPayloadVerifier.ParseMarker(bytes);
        }
        var payload = await InstalledPayloadVerifier.VerifyAsync(root, version, marker.SourceCommit,
            marker.PayloadManifestSha256, profile.CloudflaredSha256!, token);
        try {
            ExeUpdateWindowsTrust.VerifyManagedRelease(root, version);
            using var current = Process.GetCurrentProcess();
            var owner = new ExeUpdateInstalledOwner(ExeUpdateWindowsNative.CurrentSid(), current.SessionId, version, root,
                marker.Owner, payload.PayloadManifestSha256, payload.SourceCommit, payload.AppHostSha256, payload.ManagedAssemblySha256);
            return await SingleInstance.RequestQuitAsync("pilot", (pipe, _) => {
                using var observed = Process.GetProcessById(ExeUpdateWindowsNative.PipePeer(pipe, server: false));
                var bound = ExeUpdateWindowsNative.OpenBoundProcess(ExeUpdateWindowsNative.ProcessIdentity(observed), owner);
                try { ExeUpdateWindowsTrust.CheckOwner(owner); }
                catch { bound.Dispose(); throw; }
                // Hash validation happens before connecting so the 750ms restore endpoint
                // remains responsive. Keep exact payload and actual OS peer handles until ACK.
                return Task.FromResult<IAsyncDisposable>(new QuitPeer(bound));
            });
        } finally { await payload.DisposeAsync(); }
    }

    private sealed class QuitPeer(Process process) : IAsyncDisposable
    {
        public ValueTask DisposeAsync() { process.Dispose(); return ValueTask.CompletedTask; }
    }

    // This method intentionally preserves its caller's synchronization context: Windows mutex ownership
    // must be released on the original UI thread after all async session work has drained.
    internal static Task<int> RunAsync((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments,
        Func<IDisposable?> tryOwn, Func<AccessMode, IExplorerPreviewSession> prepare) =>
        RunAsync(compiled, arguments, tryOwn, prepare,
            _ => Task.FromResult(LegacyExplorerPreviewCleanupResult.NoKnownReceipt));

    internal static async Task<int> RunAsync((bool Packaged, ReleaseChannel? Channel) compiled, IReadOnlyList<string> arguments,
        Func<IDisposable?> tryOwn, Func<AccessMode, IExplorerPreviewSession> prepare,
        Func<bool, Task<LegacyExplorerPreviewCleanupResult>> legacyCleanup,
        Func<IExplorerPreviewSession, Task<bool>>? validatePublishedForTest = null,
        Func<IDisposable, Task<LegacyExplorerPreviewCleanupResult>>? interactiveRecovery = null)
    {
#if LEDGETOP_PACKAGED_BUILD
        if (validatePublishedForTest is not null) return 20;
#endif
        if (!compiled.Packaged || compiled.Channel != ReleaseChannel.Pilot || arguments.Count != 1 ||
            arguments[0] is not (CheckArgument or RemoveArgument or LegacyRemoveArgument or RetireLegacyArgument or ProbeLegacyArgument or RecoverLegacyInteractiveArgument)) return 20;
        var sessions = new List<IExplorerPreviewSession>();
        var result = 20;
        var legacyReceiptMissing = false;
        try {
            using var owner = tryOwn();
            if (owner is null) return 10;
            if (arguments[0] == RecoverLegacyInteractiveArgument) {
                if (interactiveRecovery is null) return 20;
                return await interactiveRecovery(owner) switch {
                    LegacyExplorerPreviewCleanupResult.Removed or LegacyExplorerPreviewCleanupResult.NoKnownReceipt or LegacyExplorerPreviewCleanupResult.Postponed => 0,
                    LegacyExplorerPreviewCleanupResult.Busy => 10,
                    _ => 20
                };
            }
            if (arguments[0] == ProbeLegacyArgument) {
                // Read-only probe is only a UI hint; the subsequent cleanup repeats
                // all ownership checks. Missing is not proof all entries are absent.
                return await legacyCleanup(false) switch {
                    LegacyExplorerPreviewCleanupResult.RecordedProfile => 0,
                    LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified => 11,
                    LegacyExplorerPreviewCleanupResult.NoKnownReceipt => 12,
                    LegacyExplorerPreviewCleanupResult.Busy => 10,
                    _ => 20
                };
            }
            if (arguments[0] is LegacyRemoveArgument or RetireLegacyArgument) {
                // Explicit repair for the old portable demo; never prepare/remove Company or Client roots.
                // Installation retirement treats no receipt as a no-op, never proof of navigation absence.
                // Explicit repair still refuses a missing receipt. Both reuse exact persisted ownership
                // and removal phases; neither guesses a registry entry or replays ambiguous unregister.
                return await legacyCleanup(true) switch {
                    LegacyExplorerPreviewCleanupResult.Removed or LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified => 0,
                    LegacyExplorerPreviewCleanupResult.NoKnownReceipt when arguments[0] == RetireLegacyArgument => 0,
                    LegacyExplorerPreviewCleanupResult.Busy => 10,
                    _ => 20
                };
            }
            try {
                // Validate both sources before any removal. No helper, backend or source request exists here.
                foreach (var mode in new[] { AccessMode.Client, AccessMode.Employee }) {
                    var session = prepare(mode); sessions.Add(session);
                    if (session.State == ExplorerPreviewState.Failed) {
                        var valid = arguments[0] switch {
                            CheckArgument => validatePublishedForTest is not null ? await validatePublishedForTest(session) :
                                session is ConnectedExplorerSession connected && await connected.ValidatePublishedSelectorForInstallAsync(),
                            RemoveArgument => session is ConnectedExplorerSession removable && removable.CanRemovePublishedFreshForInstaller,
                            _ => false
                        };
                        if (!valid) throw new IOException("Owned connection needs review.");
                    }
                }
                if (arguments[0] == RemoveArgument) {
                    // Legacy cleanup is explicit uninstall work, never an install/startup migration.
                    // One call retains its singleton/session through validation and removal; splitting
                    // preflight/removal could adopt a different demo generation between the calls.
                    // Multi-root cleanup is sequential: a later failure retains exact completed journals.
                    var legacy = await legacyCleanup(true);
                    // An old portable Preview may predate the durable ownership receipt. Only after
                    // exact native/shell identity discovery and a separate user confirmation may its
                    // generated root be adopted for journaled removal. Unknown candidates still fail
                    // closed; the ordinary install/startup path never invokes this recovery.
                    if (legacy == LegacyExplorerPreviewCleanupResult.NoKnownReceipt && interactiveRecovery is not null)
                        legacy = await interactiveRecovery(owner);
                    legacyReceiptMissing = legacy == LegacyExplorerPreviewCleanupResult.NoKnownReceipt;
                    if (legacy == LegacyExplorerPreviewCleanupResult.Busy) throw new LegacyPreviewBusyException();
                    if (legacy is not (LegacyExplorerPreviewCleanupResult.NoKnownReceipt or
                        LegacyExplorerPreviewCleanupResult.Removed or LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified))
                        throw new IOException("The recorded legacy preview removal was not confirmed.");
                    foreach (var session in sessions) {
                        await session.RemoveAsync();
                        if (session.State != ExplorerPreviewState.Removed) throw new IOException("Owned removal was not confirmed.");
                    }
                }
                result = arguments[0] == RemoveArgument && legacyReceiptMissing ? 12 : 0;
            } catch (LegacyPreviewBusyException) { result = 10; }
            catch { result = 20; }
            finally {
                foreach (var session in sessions) {
                    try { await session.DisposeAsync(); } catch { result = 20; }
                }
            }
        } catch { return 20; }
        return result;
    }

    private sealed class LegacyPreviewBusyException : IOException { }

    private static IExplorerPreviewSession Prepare(AccessMode mode)
    {
        var profile = ReleaseProfiles.For(ReleaseChannel.Pilot) ?? throw new IOException("Pilot profile unavailable.");
        if (profile.Channel != ReleaseChannel.Pilot || profile.StaffApplicationUrl is null) throw new IOException("Pilot sources unavailable.");
        var origin = new Uri((mode == AccessMode.Client ? profile.PortalApplicationUrl : profile.StaffApplicationUrl).GetLeftPart(UriPartial.Authority));
        var stateBase = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LedgeTop", "Files", "pilot");
        var root = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "LedgeTop Files Pilot — " + (mode == AccessMode.Client ? "Client deliveries" : "Company files"));
        var indexPath = Path.Combine(stateBase, "connected-explorer-pilot-" + AccessModes.Alias(mode), "current.json");
        if (!File.Exists(indexPath)) RefuseUntrackedRootAliases(root);
        return new ConnectedExplorerSession(() => throw new InvalidOperationException("Installer maintenance cannot create a backend."),
            "pilot", AccessModes.Alias(mode), origin, stateBase, root);
    }

    internal static void RefuseUntrackedRootAliases(string root, Func<string, int>? inspect = null)
    {
        // This context is intentionally not an ownership claim. Any registered root, even one
        // matching this value, is refused; only the exact native absence status is acceptable.
        inspect ??= candidate => NativeRootRegistration.Inspect(candidate,
            System.Text.Encoding.UTF8.GetBytes("LedgeTop.Files.InstallerMaintenance.ReadOnly/1")).Hresult;
        var parent = Path.GetDirectoryName(root)!;
        if (!Directory.Exists(parent)) throw new IOException("The local profile is unavailable.");
        var leaf = Path.GetFileName(root);
        foreach (var candidate in Directory.EnumerateFileSystemEntries(parent, leaf + "*", SearchOption.TopDirectoryOnly)) {
            var name = Path.GetFileName(candidate);
            if (name != leaf) {
                if (!name.StartsWith(leaf + " (", StringComparison.Ordinal) || !name.EndsWith(')')) continue;
                var suffix = name[(leaf.Length + 2)..^1];
                if (!int.TryParse(suffix, System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out var number) ||
                    number is < 2 or > 9999 || suffix != number.ToString(System.Globalization.CultureInfo.InvariantCulture)) continue;
            }
            if (inspect(candidate) != unchecked((int)0x80070186))
                throw new IOException("An untracked Explorer root has registered or unknown native state and requires ownership review.");
        }
    }
}
