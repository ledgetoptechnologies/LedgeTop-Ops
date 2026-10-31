using LedgeTop.Files.Updates;
using System.Security.Cryptography;

namespace LedgeTop.Files;

// Unwired durable selector primitive. Caller must hold the existing per-index lease,
// validate the exact schema-1 owner/profile and authenticated scope, and preserve both
// generations. This version admits one fresh-generation operation only; it is not a
// repeatable refresh/history mechanism. This is not a compare-and-swap against an
// uncooperative same-user process or a proven power-loss-durable directory transaction.
internal static class FreshGenerationIndexStore
{
    internal const string Current = "current.json";
    internal const string LegacyBackup = "pre-generation-index.json";
    private const int Limit = 16384;
    // Construct only after exact schema-1 bytes, account/source and old profile ownership were verified.
    internal sealed record LegacyBinding(long Revision, string Sid, string Channel, string Source,
        string OriginSha256, string Principal, FreshGenerationPlan.Generation Old);

    internal static async Task<byte[]> PublishAsync(string directory, byte[] expected, FreshGenerationIndexCodec.Index next,
        Func<bool> exactIndexLeaseStillOwned, Func<byte[], LegacyBinding?> verifyOwnedSchema1)
    {
        ArgumentNullException.ThrowIfNull(exactIndexLeaseStillOwned); ArgumentNullException.ThrowIfNull(verifyOwnedSchema1);
        if (!Path.IsPathFullyQualified(directory) || directory.StartsWith("\\\\", StringComparison.Ordinal) ||
            !string.Equals(Path.GetFullPath(directory), directory, StringComparison.OrdinalIgnoreCase) ||
            Path.GetFileName(directory) != "connected-explorer-pilot-employee") throw new IOException("Unowned index directory.");
        if (expected.Length is < 1 or > Limit || !exactIndexLeaseStillOwned()) throw new IOException("Index ownership is not current.");
        if (next.Channel != "pilot" || next.Source != "employee") throw new IOException("Fresh selector source does not match this index directory.");
        var nextBytes = FreshGenerationIndexCodec.Encode(next);
        await using var fence = Hold(directory);
        if (!Read(directory, Current).AsSpan().SequenceEqual(expected)) throw new IOException("Current selector changed.");
        var priorIsGeneration = IsGeneration(expected);
        if (priorIsGeneration) {
            var prior = FreshGenerationIndexCodec.Decode(expected);
            if (next.Revision != checked(prior.Revision + 1) || next.Sid != prior.Sid || next.Channel != prior.Channel ||
                next.Source != prior.Source || next.Principal != prior.Principal || next.OriginSha256 != prior.OriginSha256 ||
                next.LegacyBackupSha256 != prior.LegacyBackupSha256 ||
                Convert.ToHexStringLower(SHA256.HashData(Read(directory, LegacyBackup))) != prior.LegacyBackupSha256 ||
                next.State.Old != prior.State.Old || next.State.New != prior.State.New ||
                (prior.State.Phase == FreshGenerationPlan.Phase.NewReady && next.State.ReadyRoot != prior.State.ReadyRoot) ||
                (int)next.State.Phase != (int)prior.State.Phase + 1)
                throw new IOException("Generation selector transition is not consecutive.");
        } else {
            // The caller strictly validates exact bytes as the owned schema-1 index and returns its revision.
            // Keep its bytes separately before ever replacing current.json; never overwrite a backup.
            var legacy = verifyOwnedSchema1(expected);
            if (legacy is null || legacy.Revision < 1 || next.Revision != checked(legacy.Revision + 1) ||
                next.LegacyBackupSha256 != Convert.ToHexStringLower(SHA256.HashData(expected)) ||
                next.Sid != legacy.Sid || next.Channel != legacy.Channel || next.Source != legacy.Source ||
                next.OriginSha256 != legacy.OriginSha256 || next.Principal != legacy.Principal || next.State.Old != legacy.Old ||
                next.State.Phase != FreshGenerationPlan.Phase.Prepared || next.ActiveGeneration != next.State.Old.Id)
                throw new IOException("Initial generation selector is not prepared.");
            var backup = Path.Combine(directory, LegacyBackup);
            if (!File.Exists(backup)) {
                using var copy = new FileStream(backup, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough);
                copy.Write(expected); copy.Flush(true);
            }
            if (!Read(directory, LegacyBackup).AsSpan().SequenceEqual(expected)) throw new IOException("Legacy selector backup differs.");
        }
        var temporary = Path.Combine(directory, ".generation-index-" + Guid.NewGuid().ToString("N") + ".tmp");
        using (var output = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough)) {
            output.Write(nextBytes); output.Flush(true);
        }
        // Failed or unknown outcomes retain the temp/backup for ownership review; never blindly retry.
        if (!exactIndexLeaseStillOwned() || !Read(directory, Current).AsSpan().SequenceEqual(expected) ||
            Convert.ToHexStringLower(SHA256.HashData(Read(directory, LegacyBackup))) != next.LegacyBackupSha256)
            throw new IOException("Index ownership, selector or retained backup changed before publication.");
        File.Move(temporary, Path.Combine(directory, Current), overwrite: true);
        if (!Read(directory, Current).AsSpan().SequenceEqual(nextBytes)) throw new IOException("Published selector could not be verified.");
        return nextBytes;
    }
    private static bool IsGeneration(byte[] bytes)
    {
        try { _ = FreshGenerationIndexCodec.Decode(bytes); return true; }
        catch (Exception error) when (error is IOException or System.Text.Json.JsonException or ArgumentException) { return false; }
    }
    private static VerifiedInstalledPayload Hold(string directory)
    {
        var fence = new VerifiedInstalledPayload(directory);
        try {
            var parents = new Stack<string>();
            for (string? part = directory; part is not null; part = Path.GetDirectoryName(part)) parents.Push(part);
            while (parents.TryPop(out var part)) fence.HoldDirectory(part);
            return fence;
        } catch { fence.DisposeAsync().GetAwaiter().GetResult(); throw; }
    }
    private static byte[] Read(string directory, string leaf)
    {
        var guard = new VerifiedInstalledPayload(directory);
        try {
            var file = guard.HoldFile(leaf);
            if (file.Length is < 1 or > Limit) throw new IOException("Selector file is invalid.");
            var bytes = new byte[(int)file.Length]; file.ReadExactly(bytes); return bytes;
        } finally { guard.DisposeAsync().GetAwaiter().GetResult(); }
    }
}
