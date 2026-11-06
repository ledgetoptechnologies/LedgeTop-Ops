using LedgeTop.Files.Explorer;
using System.Security.Principal;
using System.Text;
using Windows.Security.Cryptography;
using Windows.Storage.Provider;

namespace LedgeTop.Files;

internal enum LegacyExplorerPreviewCleanupResult
{
    NoKnownReceipt, RecordedProfile, Removed, AlreadyRemovedVerified, Busy, NeedsOwnershipReview, Postponed
}

internal enum LegacyExplorerPreviewReceiptState { Missing, Present, Unknown }

/// <summary>
/// Fixed generated V2 preview cleanup only. A missing or already-removed receipt is never proof
/// that an untracked Explorer entry is absent. Does not start a provider, authenticate, delete user
/// files, or accept a path from the caller. Missing receipts are left untouched until a separately
/// confirmed recovery flow binds an exact candidate. Caller preserves its UI context:
/// the legacy SingleInstance mutex must be released on the same thread that acquired it.
/// Invoked by packaged-pilot uninstall, explicit repair, and post-activation installation retirement;
/// ordinary app startup does not invoke cleanup.
/// </summary>
internal static class LegacyExplorerPreviewCleanup
{
    internal static string ProfilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LedgeTopFilesExplorerPreview", "v2", "profile.json");
    internal static string ProfileDirectory => Path.GetDirectoryName(ProfilePath) ?? throw new IOException("Preview profile directory is unavailable.");

    internal static Task<LegacyExplorerPreviewCleanupResult> RunAsync(bool remove, CancellationToken cancellationToken) =>
        RunDefaultAsync(remove, cancellationToken, () => SingleInstance.TryOwn("developer-explorer-demo", () => { }),
            () => ProbeReceipt(ProfilePath, File.GetAttributes), () => new ExplorerPreviewSession(),
            session => session is ExplorerPreviewSession preview && preview.VerifyRecordedRemovedAbsence());

    // Until interactive recovery binds consent to an exact generation, production never supplies
    // a discovery or writer callback for a missing receipt. This seam permits no-host testing.
    internal static Task<LegacyExplorerPreviewCleanupResult> RunDefaultAsync(bool remove, CancellationToken token,
        Func<IDisposable?> tryOwn, Func<LegacyExplorerPreviewReceiptState> hasReceipt, Func<IExplorerPreviewSession> prepare,
        Func<IExplorerPreviewSession, bool> verifyRemoved) =>
        RunAsync(remove, token, tryOwn, hasReceipt, prepare, verifyRemoved);

    // Called only by the interactive installer helper, which already owns the pilot mutex.
    // The legacy mutex and the exact directory handles stay alive across confirmation, receipt
    // creation, journaled removal and absence readback. Shell metadata is checked immediately
    // before unregister, but Windows offers no conditional cross-process registry transaction here.
    internal static async Task<LegacyExplorerPreviewCleanupResult> RecoverInteractivelyAsync(IDisposable pilotOwner, Func<bool> confirm)
    {
        using var owner = SingleInstance.TryOwn("developer-explorer-demo", () => { });
        if (owner is null) return LegacyExplorerPreviewCleanupResult.Busy;
        var receiptState = await ObserveAsync(() => ProbeReceipt(ProfilePath, File.GetAttributes));
        if (receiptState == LegacyExplorerPreviewReceiptState.Unknown)
            return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        using var fence = new CandidateDirectoryFence();
        var candidate = await ObserveAsync(DiscoverMissingGeneratedProfile);
        if (candidate is null) return NoCandidateResult(receiptState);
        var pin = await ObserveAsync(() => { fence.HoldAncestors(candidate.Root); return fence.Recheck(candidate.Root); });
        var existingBinding = receiptState == LegacyExplorerPreviewReceiptState.Present ? await ObserveAsync(CaptureExistingGeneratedBinding) : null;
        bool BindingMatches(GeneratedRemovalBinding binding) => binding.Identity == candidate.Identity && binding.Icon == candidate.Icon &&
            binding.RootFileId == candidate.FileId && binding.NamespaceClsid == candidate.Namespace &&
            string.Equals(binding.RootPath, candidate.Root, StringComparison.OrdinalIgnoreCase) &&
            string.Equals(binding.ProfileDirectory, ProfileDirectory, StringComparison.OrdinalIgnoreCase);
        bool CandidateUnchanged() => unchecked((long)pin.FileId) == candidate.FileId &&
            ProbeReceipt(ProfilePath, File.GetAttributes) == receiptState &&
            (existingBinding is null || BindingMatches(existingBinding) && CaptureExistingGeneratedBinding() == existingBinding) &&
            fence.Recheck(candidate.Root) == pin && DiscoverMissingGeneratedProfile() == candidate;
        if (!await ObserveAsync(CandidateUnchanged)) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        if (!confirm()) return LegacyExplorerPreviewCleanupResult.Postponed;
        if (!await ObserveAsync(CandidateUnchanged)) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        if (receiptState == LegacyExplorerPreviewReceiptState.Missing &&
            !await ObserveAsync(() => WriteRecoveredProfile(candidate.Root, candidate.Identity, candidate.Icon, candidate.FileId, candidate.Namespace,
                OwnedExplorerRootSession.WriteRecoveredGeneratedProfile))) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        var binding = existingBinding ?? await ObserveAsync(CaptureExistingGeneratedBinding);
        if (!BindingMatches(binding)) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        bool HeldProof() => fence.Recheck(candidate.Root) == pin && DiscoverMissingGeneratedProfile() == candidate;
        if (!await ObserveAsync(HeldProof)) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        var session = await ObserveAsync(() => new ExplorerPreviewSession());
        // After removal begins, an unknown native outcome must not release our proof handles or
        // allow an automatic retry. Keep this helper alive for manual reconciliation instead.
        var nativeAttempted = false;
        Task<bool> DisposeSessionAsync() => Task.Run(async () => { await session.DisposeAsync(); return true; });
        try {
            await WaitObservedAsync(CompleteRemovalAsync());
            async Task<bool> CompleteRemovalAsync() { await session.RemoveConfirmedGeneratedAsync(binding, HeldProof, () => nativeAttempted = true); return true; }
            var context = Encoding.UTF8.GetBytes("LedgeTop.Files.ExplorerPreview/1:" + candidate.Identity.ToString("N"));
            if (session.State != ExplorerPreviewState.Removed || !await ObserveAsync(() => fence.Recheck(candidate.Root) == pin &&
                ShellRegistration.Inspect(candidate.Root, ShellRegistration.CreateId(candidate.Identity), context,
                    candidate.Namespace, candidate.Icon, ExplorerRootDisplayName.Legacy).CompleteAbsenceVerified))
                throw new IOException("Legacy preview removal requires reconciliation.");
            await WaitObservedAsync(DisposeSessionAsync());
            return LegacyExplorerPreviewCleanupResult.Removed;
        } catch {
            if (!nativeAttempted) {
                if (await CleanupBeforeNativeAsync(async () => { await WaitObservedAsync(DisposeSessionAsync()); }))
                    return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
                _ = RecoveryWait.Retain(session, fence, owner, pilotOwner);
                await HoldForReviewAsync("Setup could not confirm that the Preview session closed. Setup is holding it for review. Do not retry or delete the old folder; contact LedgeTop support.", session);
            } else {
                _ = RecoveryWait.Retain(session, fence, owner, pilotOwner);
                await HoldForReviewAsync("Windows did not confirm removal of the old Preview connection. Setup is holding it for review. Do not retry or delete the old folder; contact LedgeTop support.", session);
            }
            throw;
        }
    }

    internal static LegacyExplorerPreviewCleanupResult NoCandidateResult(LegacyExplorerPreviewReceiptState state) =>
        state == LegacyExplorerPreviewReceiptState.Missing ? LegacyExplorerPreviewCleanupResult.NoKnownReceipt :
            LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;

    private static GeneratedRemovalBinding CaptureExistingGeneratedBinding()
    {
        var session = new ExplorerPreviewSession();
        try { return session.CaptureGeneratedConfirmationBinding(); }
        finally { session.DisposeAsync().AsTask().GetAwaiter().GetResult(); }
    }

    internal static async Task<bool> CleanupBeforeNativeAsync(Func<Task> dispose)
    {
        try { await dispose(); return true; } catch { return false; }
    }
    private static async Task HoldForReviewAsync(string message, object retainedSession)
    {
        try { System.Windows.MessageBox.Show(message, "LedgeTop Files Setup", System.Windows.MessageBoxButton.OK, System.Windows.MessageBoxImage.Warning); } catch { }
        await HoldLifetimeAsync(retainedSession, Task.Delay(Timeout.InfiniteTimeSpan));
    }
    internal static async Task HoldLifetimeAsync(object retainedSession, Task release)
    {
        try { await release; } finally { GC.KeepAlive(retainedSession); }
    }

    private static Task<T> ObserveAsync<T>(Func<T> operation) => WaitObservedAsync(Task.Run(operation));
    private static async Task<T> WaitObservedAsync<T>(Task<T> operation)
    {
        using var stop = new CancellationTokenSource();
        try { return await RecoveryWait.WaitAsync(operation, Task.Delay(TimeSpan.FromSeconds(15), stop.Token), ShowRecoveryWait); }
        finally { stop.Cancel(); }
    }
    private static IDisposable ShowRecoveryWait()
    {
        var window = new System.Windows.Window {
            Title = "LedgeTop Files Setup", Width = 440, Height = 155, ResizeMode = System.Windows.ResizeMode.NoResize,
            WindowStartupLocation = System.Windows.WindowStartupLocation.CenterScreen,
            Content = new System.Windows.Controls.TextBlock { TextWrapping = System.Windows.TextWrapping.Wrap, Margin = new System.Windows.Thickness(20),
                Text = "Windows is still checking the old Preview connection. Setup is waiting safely; do not close it or retry. If this continues, contact LedgeTop support." }
        };
        var notice = new RecoveryNotice(window); window.Show(); return notice;
    }
    private sealed class RecoveryNotice : IDisposable
    {
        private readonly System.Windows.Window window;
        private bool finished;
        internal RecoveryNotice(System.Windows.Window value) { window = value; window.Closing += (_, e) => { if (!finished) e.Cancel = true; }; }
        public void Dispose() { finished = true; window.Close(); }
    }

    // Null means both checks passed and the user explicitly consented; no caller may write before this.
    internal static LegacyExplorerPreviewCleanupResult? ConfirmExactCandidate(Func<bool> unchanged, Func<bool> confirm)
    {
        if (!unchanged()) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        if (!confirm()) return LegacyExplorerPreviewCleanupResult.Postponed;
        return unchanged() ? null : LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
    }

    internal static LegacyExplorerPreviewReceiptState ProbeReceipt(string path, Func<string, FileAttributes> attributes)
    {
        try {
            var parents = new List<string>();
            for (var parent = Path.GetDirectoryName(path); parent is not null; parent = Path.GetDirectoryName(parent)) parents.Add(parent);
            parents.Reverse();
            foreach (var parent in parents) {
                var value = attributes(parent);
                if ((value & FileAttributes.ReparsePoint) != 0 || (value & FileAttributes.Directory) == 0)
                    return LegacyExplorerPreviewReceiptState.Unknown;
            }
            return (attributes(path) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) == 0
                ? LegacyExplorerPreviewReceiptState.Present : LegacyExplorerPreviewReceiptState.Unknown;
        } catch (FileNotFoundException) { return LegacyExplorerPreviewReceiptState.Missing; }
        catch (DirectoryNotFoundException) { return LegacyExplorerPreviewReceiptState.Missing; }
        catch { return LegacyExplorerPreviewReceiptState.Unknown; }
    }

    // Synthetic seams expose no production path/identity override. The existing generated session
    // validates schema2, owner, current SID, root variant, context, icon and exact native/Shell pins.
    internal static async Task<LegacyExplorerPreviewCleanupResult> RunAsync(bool remove, CancellationToken cancellationToken,
        Func<IDisposable?> tryOwn, Func<LegacyExplorerPreviewReceiptState> hasReceipt, Func<IExplorerPreviewSession> prepare,
        Func<IExplorerPreviewSession, bool> verifyRemoved, Func<bool>? recoverMissing = null)
    {
        if (cancellationToken.IsCancellationRequested) return LegacyExplorerPreviewCleanupResult.Postponed;
        var result = LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
        IExplorerPreviewSession? session = null;
        try {
            using var owner = tryOwn();
            if (owner is null) return LegacyExplorerPreviewCleanupResult.Busy;
            try {
                if (cancellationToken.IsCancellationRequested) return LegacyExplorerPreviewCleanupResult.Postponed;
                var receipt = hasReceipt();
                if (receipt == LegacyExplorerPreviewReceiptState.Missing && remove && recoverMissing is not null && recoverMissing())
                    receipt = hasReceipt();
                if (receipt == LegacyExplorerPreviewReceiptState.Missing) return LegacyExplorerPreviewCleanupResult.NoKnownReceipt;
                if (receipt != LegacyExplorerPreviewReceiptState.Present) return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
                session = prepare(); // Construction reads the exact fixed receipt; never calls Start.
                if (cancellationToken.IsCancellationRequested) result = LegacyExplorerPreviewCleanupResult.Postponed;
                else if (session.State == ExplorerPreviewState.Removed)
                    result = verifyRemoved(session) ? LegacyExplorerPreviewCleanupResult.AlreadyRemovedVerified
                        : LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
                else if (session.State != ExplorerPreviewState.NotStarted)
                    result = LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
                else if (cancellationToken.IsCancellationRequested) result = LegacyExplorerPreviewCleanupResult.Postponed;
                else if (!remove) result = LegacyExplorerPreviewCleanupResult.RecordedProfile;
                else {
                    // Remove validates root/native/context/fileId/namespace and all cloud placeholders,
                    // journals one unregister intent and confirms broker/native/namespace absence.
                    // Once removal starts it must finish its ownership-safe journal, not be cancelled midway.
                    if (hasReceipt() != LegacyExplorerPreviewReceiptState.Present) result = LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
                    else {
                        await session.RemoveAsync();
                        // The core's absent-directory short circuit is not proof of unregister.
                        // Successful owned cleanup retains its phase-Removed profile journal.
                        result = session.State == ExplorerPreviewState.Removed && hasReceipt() == LegacyExplorerPreviewReceiptState.Present
                            ? LegacyExplorerPreviewCleanupResult.Removed : LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview;
                    }
                }
            } finally {
                if (session is not null) {
                    try { await session.DisposeAsync(); }
                    catch { result = LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview; }
                }
            }
        } catch { return LegacyExplorerPreviewCleanupResult.NeedsOwnershipReview; }
        return result;
    }

    /// <summary>
    /// Reconstruct only a missing receipt for one exact, still-registered legacy generated root.
    /// Enumeration is read-only; the receipt writer repeats native and shell identity checks before
    /// persisting anything. The normal session removal then journals and confirms the unregister.
    /// </summary>
    private sealed record RecoveryCandidate(string Root, Guid Identity, string Icon, long FileId, Guid Namespace);
    private static RecoveryCandidate? DiscoverMissingGeneratedProfile()
    {
        using var user = WindowsIdentity.GetCurrent();
        var sid = user.User?.Value ?? throw new IOException("The current Windows identity is unavailable.");
        var candidates = new List<(string Root, Guid Identity, string Icon, long FileId, Guid Namespace)>();
        foreach (var syncRoot in StorageProviderSyncRootManager.GetCurrentSyncRoots())
        {
            if (syncRoot is null || syncRoot.IconResource is not { } icon) continue;
            byte[] context;
            try { CryptographicBuffer.CopyToByteArray(syncRoot.Context, out context); }
            catch { continue; }
            if (!TryMatchLegacyGeneratedIdentity(syncRoot.Id, sid, syncRoot.DisplayNameResource, icon, context, out var identity)) continue;
            var expectedContext = Encoding.UTF8.GetBytes("LedgeTop.Files.ExplorerPreview/1:" + identity.ToString("N"));
            var root = syncRoot.Path?.Path;
            if (string.IsNullOrWhiteSpace(root)) continue;
            var native = NativeRootRegistration.Inspect(root, expectedContext);
            if (native.Hresult != 0 || native.RootFileId == 0 || !native.ExpectedContextMatches ||
                !native.ExpectedNameMatches || !native.ExpectedVersionMatches || native.HydrationPrimary != 2 ||
                native.HydrationModifier != 0 || native.PopulationPrimary != 3 || native.PopulationModifier != 0 ||
                native.InSyncPolicy != 1023 || native.HardlinkPolicy != 0) continue;
            var shell = ShellRegistration.Inspect(root, syncRoot.Id, expectedContext, null, icon, ExplorerRootDisplayName.Legacy);
            if (!shell.ExactShellMetadataPresent || shell.RootFileId != native.RootFileId || shell.NamespaceClsid == Guid.Empty)
                continue;
            candidates.Add((root, identity, icon, native.RootFileId, shell.NamespaceClsid));
            if (candidates.Count > 1) throw new IOException("More than one legacy preview matches; recovery requires review.");
        }
        if (candidates.Count != 1) return null;
        var candidate = candidates[0];
        return new(candidate.Root, candidate.Identity, candidate.Icon, candidate.FileId, candidate.Namespace);
    }

    internal static bool WriteRecoveredProfile(string root, Guid identity, string icon, long fileId, Guid namespaceId,
        Func<string, string, Guid, string, long, Guid, bool> writer) =>
        writer(ProfileDirectory, root, identity, icon, fileId, namespaceId);

    internal static bool TryMatchLegacyGeneratedIdentity(string? id, string sid, string? displayName,
        string icon, byte[] context, out Guid identity)
    {
        identity = Guid.Empty;
        if (displayName != ExplorerRootDisplayName.Legacy || !ExplorerBrandIcon.IsKnownResource(icon) ||
            string.IsNullOrWhiteSpace(sid) || string.IsNullOrEmpty(id) || context is null) return false;
        var prefix = NativeRootRegistration.ProviderName + "!" + sid + "!";
        if (!id.StartsWith(prefix, StringComparison.Ordinal) ||
            !Guid.TryParseExact(id[prefix.Length..], "N", out identity) || identity == Guid.Empty ||
            id != prefix + identity.ToString("N"))
        { identity = Guid.Empty; return false; }
        var expected = Encoding.UTF8.GetBytes("LedgeTop.Files.ExplorerPreview/1:" + identity.ToString("N"));
        if (context.AsSpan().SequenceEqual(expected)) return true;
        identity = Guid.Empty;
        return false;
    }
}
