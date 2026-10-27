using LedgeTop.Files.Explorer;

namespace LedgeTop.Files;

internal enum LegacyExplorerPreviewCleanupResult
{
    NoKnownReceipt, RecordedProfile, Removed, AlreadyRemovedVerified, Busy, NeedsOwnershipReview, Postponed
}

internal enum LegacyExplorerPreviewReceiptState { Missing, Present, Unknown }

/// <summary>
/// Fixed generated V2 preview cleanup only. A missing or already-removed receipt is never proof
/// that an untracked Explorer entry is absent. Does not start a provider, authenticate, delete files,
/// enumerate registrations, or accept a path from the caller. Caller must preserve its UI context:
/// the legacy SingleInstance mutex must be released on the same thread that acquired it.
/// Not wired to installer/startup; invocation needs a separately reviewed maintenance hook.
/// </summary>
internal static class LegacyExplorerPreviewCleanup
{
    internal static string ProfilePath => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "LedgeTopFilesExplorerPreview", "v2", "profile.json");

    internal static Task<LegacyExplorerPreviewCleanupResult> RunAsync(bool remove, CancellationToken cancellationToken) =>
        RunAsync(remove, cancellationToken, () => SingleInstance.TryOwn("developer-explorer-demo", () => { }),
            () => ProbeReceipt(ProfilePath, File.GetAttributes), () => new ExplorerPreviewSession(),
            session => session is ExplorerPreviewSession preview && preview.VerifyRecordedRemovedAbsence());

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
        Func<IExplorerPreviewSession, bool> verifyRemoved)
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
}
